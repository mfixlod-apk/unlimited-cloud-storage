import { Buffer } from "buffer";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { Logger, PromisedWebSockets } from "teleproto/extensions";
import { LogLevel } from "teleproto/extensions/Logger";
import { localStore } from "./storage";

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export interface CloudChannel {
  id: string;
  title: string;
  inputEntity: any;
  isPublic: boolean;
  canWrite: boolean;
  canRename: boolean;
  canDelete: boolean;
}

export type ItemKind = "image" | "video" | "audio" | "file";

export interface CloudItem {
  id: number;
  channelId: string;
  name: string;
  kind: ItemKind;
  mime: string;
  size: number;
  date: Date;
  duration?: number;
}

export interface HistoryPage {
  items: CloudItem[];
  nextOffset: number;
  hasMore: boolean;
}

export interface ProgressiveStream {
  url: string;
  close: () => void;
}

interface ProgressiveStreamEntry {
  channel: CloudChannel;
  item: CloudItem;
  requests: Map<string, AbortController>;
}

export interface AuthCallbacks {
  onQr: (uri: string, expires: number) => Promise<void> | void;
  askPassword: (hint?: string) => Promise<string>;
  signal: AbortSignal;
}

export interface PhoneCallbacks {
  phone: string;
  askCode: (viaApp?: boolean) => Promise<string>;
  askPassword: (hint?: string) => Promise<string>;
}

const asNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (value && typeof (value as { toJSNumber?: () => number }).toJSNumber === "function") {
    return (value as { toJSNumber: () => number }).toJSNumber();
  }
  return Number(value) || 0;
};

const toBlob = (data: Buffer | string | undefined, mime: string): Blob | undefined => {
  if (!data || typeof data === "string") return undefined;
  return new Blob([new Uint8Array(data)], { type: mime });
};

const TELEGRAM_REQUEST_TIMEOUT = 45_000;
const PROGRESSIVE_CHUNK_SIZE = 1024 * 1024;
const UPLOAD_PART_WORKERS = 3;
const UNSAFE_FILE_NAME_CHARACTERS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);
const VIDEO_EXTENSIONS = new Set(["3g2", "3gp", "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm", "wmv"]);
const AUDIO_EXTENSIONS = new Set(["aac", "aiff", "alac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "wma"]);

const base64Url = (value: Uint8Array) => Buffer.from(value)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/g, "");
const thumbnailCacheKey = (channelId: string, messageId: number) => `v3:${channelId}:${messageId}`;

export const safeFileName = (value: unknown, fallback: string) => {
  const raw = typeof value === "string" ? value : "";
  const leaf = raw.split(/[\\/]/).pop()?.replace(UNSAFE_FILE_NAME_CHARACTERS, "").trim();
  return leaf?.slice(0, 255) || fallback;
};

const fileExtension = (name: string) => name.toLocaleLowerCase().match(/\.([^.]+)$/)?.[1] || "";

const uploadKind = (file: File): ItemKind => {
  const extension = fileExtension(file.name);
  if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) return "image";
  if (file.type.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) return "video";
  if (file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)) return "audio";
  return "file";
};

const uploadAttributes = (file: File, kind: ItemKind) => {
  const attributes: Api.TypeDocumentAttribute[] = [
    new Api.DocumentAttributeFilename({ fileName: file.name }),
  ];
  if (kind === "video") {
    attributes.push(new Api.DocumentAttributeVideo({
      duration: 0,
      h: 1,
      w: 1,
      roundMessage: false,
      supportsStreaming: file.type === "video/mp4" || ["m4v", "mp4"].includes(fileExtension(file.name)),
    }));
  } else if (kind === "audio") {
    attributes.push(new Api.DocumentAttributeAudio({ duration: 0, voice: false }));
  }
  return attributes;
};

const withTimeout = <T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> => new Promise((resolve, reject) => {
  const timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
  operation.then(
    (value) => { window.clearTimeout(timer); resolve(value); },
    (error) => { window.clearTimeout(timer); reject(error); },
  );
});

export class TelegramDrive {
  private client?: TelegramClient<StringSession>;
  private credentials?: TelegramCredentials;
  private messageCache = new Map<string, any>();
  private progressiveStreams = new Map<string, ProgressiveStreamEntry>();
  private activeThumbnailRequests = 0;
  private readonly maxConcurrentThumbnailRequests = 3;
  private thumbnailQueue: Array<{
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    onAbort?: () => void;
  }> = [];

  private acquireThumbnailSlot(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException("Thumbnail cancelled", "AbortError"));
    return new Promise((resolve, reject) => {
      const entry: (typeof this.thumbnailQueue)[number] = { signal, resolve, reject };
      if (signal) {
        entry.onAbort = () => {
          const index = this.thumbnailQueue.indexOf(entry);
          if (index >= 0) {
            this.thumbnailQueue.splice(index, 1);
            reject(new DOMException("Thumbnail cancelled", "AbortError"));
          }
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      if (this.activeThumbnailRequests < this.maxConcurrentThumbnailRequests) {
        this.activeThumbnailRequests += 1;
        if (entry.onAbort && signal) signal.removeEventListener("abort", entry.onAbort);
        resolve(this.createThumbnailRelease());
      } else {
        this.thumbnailQueue.push(entry);
      }
    });
  }

  private createThumbnailRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeThumbnailRequests = Math.max(0, this.activeThumbnailRequests - 1);
      while (this.thumbnailQueue.length && this.activeThumbnailRequests < this.maxConcurrentThumbnailRequests) {
        const next = this.thumbnailQueue.shift()!;
        if (next.onAbort && next.signal) next.signal.removeEventListener("abort", next.onAbort);
        if (next.signal?.aborted) {
          next.reject(new DOMException("Thumbnail cancelled", "AbortError"));
          continue;
        }
        this.activeThumbnailRequests += 1;
        next.resolve(this.createThumbnailRelease());
      }
    };
  }

  constructor() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "telegram-stream-cancel") {
          const stream = this.progressiveStreams.get(String(event.data.token));
          stream?.requests.get(String(event.data.requestId))?.abort();
          return;
        }
        if (event.data?.type !== "telegram-stream-range" || !event.ports[0]) return;
        const port = event.ports[0];
        const stream = this.progressiveStreams.get(String(event.data.token));
        if (!stream) {
          port.postMessage({ ok: false, error: "This progressive stream has expired." });
          return;
        }
        const start = Math.max(0, Number(event.data.start) || 0);
        const length = Math.max(1, Math.min(PROGRESSIVE_CHUNK_SIZE, Number(event.data.length) || 0));
        const requestId = String(event.data.requestId);
        const controller = new AbortController();
        stream.requests.set(requestId, controller);
        void this.downloadRange(stream.channel, stream.item, start, length, controller.signal).then((bytes) => {
          if (controller.signal.aborted) return;
          const transferable = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          port.postMessage({ ok: true, bytes: transferable, size: stream.item.size, mime: stream.item.mime }, [transferable]);
        }).catch((cause) => {
          try {
            port.postMessage({
              ok: false,
              cancelled: controller.signal.aborted,
              error: controller.signal.aborted ? "Stream range cancelled" : cause instanceof Error ? cause.message : String(cause),
            });
          } catch {
            // The worker already discarded this range and closed its port.
          }
        }).finally(() => {
          stream.requests.delete(requestId);
        });
      });
    }
  }

  async connect(credentials: TelegramCredentials, session = "") {
    await this.disconnect();
    this.credentials = credentials;
    this.client = new TelegramClient(new StringSession(session), credentials.apiId, credentials.apiHash, {
      networkSocket: PromisedWebSockets,
      connectionRetries: 5,
      reconnectRetries: 5,
      requestRetries: 4,
      maxConcurrentDownloads: 2,
      floodSleepThreshold: 30,
      baseLogger: new Logger(LogLevel.NONE),
      deviceModel: "Unlimited Cloud Storage Web",
      systemVersion: navigator.platform || "Web",
      appVersion: "1.0.0",
    });
    await this.client.connect();
    return this.client.checkAuthorization();
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        // A dead socket is already disconnected.
      }
    }
    this.client = undefined;
    this.messageCache.clear();
    for (const stream of this.progressiveStreams.values()) {
      for (const request of stream.requests.values()) request.abort();
    }
    this.progressiveStreams.clear();
  }

  async logOut() {
    if (this.client) await this.client.logOut();
    await this.disconnect();
  }

  async loginWithQr({ onQr, askPassword, signal }: AuthCallbacks) {
    const client = this.requiredClient();
    const credentials = this.requiredCredentials();
    const user = await client.signInUserWithQrCode(credentials, {
      qrCode: async ({ token, expires }) => {
        // buffer's browser polyfill does not consistently implement the
        // Node-only `base64url` encoding name, so encode it portably.
        const uri = `tg://login?token=${base64Url(token)}`;
        await onQr(uri, expires);
      },
      password: askPassword,
      abortSignal: signal,
      onError: async (error) => {
        if (signal.aborted) return true;
        const message = error.message.toUpperCase();
        return !message.includes("TOKEN") && !message.includes("TIMEOUT");
      },
    });
    return user;
  }

  async loginWithPhone({ phone, askCode, askPassword }: PhoneCallbacks) {
    const client = this.requiredClient();
    const credentials = this.requiredCredentials();
    return client.signInUser(credentials, {
      phoneNumber: async () => phone,
      phoneCode: askCode,
      password: askPassword,
      firstAndLastNames: async () => {
        throw new Error("Create your Telegram account in the official app before signing in here.");
      },
      onError: async () => true,
    });
  }

  sessionString() {
    return String(this.requiredClient().session.save());
  }

  async getMe() {
    return this.requiredClient().getMe();
  }

  async listPrivateChannels(): Promise<CloudChannel[]> {
    // Omitting the limit lets Teleproto paginate through every dialog,
    // including archived folders, instead of stopping after the first 100.
    const dialogs = await this.requiredClient().getDialogs({});
    return dialogs
      .filter((dialog: any) => {
        const entity = dialog.entity as any;
        return dialog.isChannel && entity?.broadcast === true && entity?.left !== true;
      })
      .map((dialog: any) => ({
        id: dialog.id?.toString() || dialog.inputEntity?.channelId?.toString(),
        title: dialog.title || dialog.name || "Private channel",
        inputEntity: dialog.inputEntity,
        isPublic: Boolean((dialog.entity as any)?.username),
        canWrite: Boolean((dialog.entity as any)?.creator || (dialog.entity as any)?.adminRights?.postMessages),
        canRename: Boolean((dialog.entity as any)?.creator || (dialog.entity as any)?.adminRights?.changeInfo),
        // Telegram only permits the channel owner to delete the entire channel.
        canDelete: Boolean((dialog.entity as any)?.creator),
      }))
      .filter((channel: CloudChannel) => Boolean(channel.id));
  }

  async createPrivateChannel(title: string): Promise<CloudChannel> {
    const client = this.requiredClient();
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new Error("Enter a name for the storage channel.");
    const created = await client.createChannel({
      title: cleanTitle,
      about: "Private storage channel created by Unlimited Cloud Storage.",
    });
    return {
      id: created.id.toString(),
      title: created.title || cleanTitle,
      inputEntity: await client.getInputEntity(created),
      isPublic: false,
      canWrite: true,
      canRename: true,
      canDelete: true,
    };
  }

  async renameChannel(channel: CloudChannel, title: string): Promise<CloudChannel> {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new Error("Enter a channel name.");
    if (cleanTitle.length > 128) throw new Error("Keep the channel name under 128 characters.");
    await this.requiredClient().invoke(new Api.channels.EditTitle({
      channel: channel.inputEntity,
      title: cleanTitle,
    }));
    return { ...channel, title: cleanTitle };
  }

  async deleteChannel(channel: CloudChannel) {
    await this.requiredClient().invoke(new Api.channels.DeleteChannel({ channel: channel.inputEntity }));
    for (const key of this.messageCache.keys()) {
      if (key.startsWith(`${channel.id}:`)) this.messageCache.delete(key);
    }
  }

  async getHistory(channel: CloudChannel, offsetId = 0, limit = 100, reverse = false): Promise<HistoryPage> {
    const messages = await withTimeout(
      this.requiredClient().getMessages(channel.inputEntity, {
        limit,
        offsetId: offsetId || undefined,
        reverse,
      }),
      TELEGRAM_REQUEST_TIMEOUT,
      "Telegram took too long to load this part of the channel history. Try again.",
    );
    const raw = Array.from(messages as any[]);
    for (const message of raw) {
      if (message?.id && message?.media) this.rememberMessage(channel.id, Number(message.id), message);
    }
    const items = raw.flatMap((message: any) => {
      const item = this.toCloudItem(message, channel.id);
      return item ? [item] : [];
    });
    const ids = raw.map((message: any) => Number(message.id)).filter(Number.isFinite);
    const nextOffset = ids.length ? (reverse ? Math.max(...ids) : Math.min(...ids)) : offsetId;
    return {
      items,
      nextOffset,
      hasMore: raw.length === limit && ids.length > 0 && nextOffset !== offsetId,
    };
  }

  async getCachedThumbnail(item: CloudItem) {
    return localStore.getThumbnail(thumbnailCacheKey(item.channelId, item.id));
  }

  async getThumbnail(channel: CloudChannel, item: CloudItem, signal?: AbortSignal, fallback = false): Promise<Blob | undefined> {
    const release = await this.acquireThumbnailSlot(signal);
    try {
      return await this.getThumbnailWithSlot(channel, item, signal, fallback);
    } finally {
      release();
    }
  }

  private async getThumbnailWithSlot(channel: CloudChannel, item: CloudItem, signal?: AbortSignal, fallback = false): Promise<Blob | undefined> {
    // v2 invalidates the former smallest-size thumbnails.
    const key = thumbnailCacheKey(item.channelId, item.id);
    const cached = fallback ? undefined : await localStore.getThumbnail(key);
    if (cached?.size) return cached;
    if (fallback || cached) await localStore.deleteThumbnail(key);
    if (item.kind !== "image" && item.kind !== "video") return undefined;
    const message = await this.getMessage(channel, item.id);
    if (signal?.aborted) throw new DOMException("Thumbnail cancelled", "AbortError");
    const media = message?.photo || message?.document;
    const thumbnails = [...(media?.sizes || media?.thumbs || []), ...(media?.videoSizes || [])]
      .filter((thumbnail: any) => thumbnail?.className !== "PhotoPathSize");
    const data = await this.requiredClient().downloadMedia(message, {
      // Prefer the second-smallest rendition, but retain support for media
      // that exposes only one usable Telegram thumbnail.
      thumb: fallback ? Math.max(0, thumbnails.length - 1) : thumbnails.length > 1 ? 1 : 0,
      requestTimeout: TELEGRAM_REQUEST_TIMEOUT,
      signal,
    });
    const blob = toBlob(data, "image/jpeg");
    if (blob?.size) await localStore.saveThumbnail(key, blob);
    return blob;
  }

  async download(channel: CloudChannel, item: CloudItem, onProgress?: (value: number) => void, signal?: AbortSignal) {
    const message = await this.getMessage(channel, item.id);
    const data = await this.requiredClient().downloadMedia(message, {
      signal,
      progressCallback: (received: any, total: any) => {
        const full = asNumber(total) || item.size;
        if (full > 0) onProgress?.(Math.min(1, asNumber(received) / full));
      },
    });
    if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
    const blob = toBlob(data, item.mime || "application/octet-stream");
    if (!blob) throw new Error("Telegram did not return the file data. Try the download again.");
    onProgress?.(1);
    return blob;
  }

  async downloadTo(
    channel: CloudChannel,
    item: CloudItem,
    write: (chunk: Uint8Array<ArrayBuffer>) => Promise<void>,
    onProgress?: (value: number) => void,
    signal?: AbortSignal,
  ) {
    const message = await this.getMessage(channel, item.id);
    await this.requiredClient().downloadMedia(message, {
      outputFile: {
        write: (chunk: Buffer) => write(Uint8Array.from(chunk)),
        close: () => undefined,
      },
      signal,
      progressCallback: (received: any, total: any) => {
        const full = asNumber(total) || item.size;
        if (full > 0) onProgress?.(Math.min(1, asNumber(received) / full));
      },
    });
    if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
    onProgress?.(1);
  }

  async openProgressiveStream(channel: CloudChannel, item: CloudItem): Promise<ProgressiveStream> {
    if (!("serviceWorker" in navigator)) throw new Error("Progressive playback is not supported by this browser.");
    if (!Number.isSafeInteger(item.size) || item.size <= 0) throw new Error("This file does not report a streamable size.");
    await navigator.serviceWorker.ready;
    const controller = await this.waitForServiceWorkerController();
    if (!controller) throw new Error("The progressive playback worker is not ready.");
    const token = crypto.randomUUID();
    const stream: ProgressiveStreamEntry = { channel, item, requests: new Map() };
    this.progressiveStreams.set(token, stream);
    const url = new URL(`__telegram_stream__/${token}/${item.size}`, document.baseURI).href;
    return {
      url,
      close: () => {
        for (const request of stream.requests.values()) request.abort();
        this.progressiveStreams.delete(token);
      },
    };
  }

  private async downloadRange(channel: CloudChannel, item: CloudItem, offset: number, length: number, signal: AbortSignal) {
    const message = await this.getMessage(channel, item.id);
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of this.requiredClient().iterDownload(message, {
      offset,
      limit: length,
      requestSize: 512 * 1024,
      signal,
    })) {
      if (signal.aborted) throw new DOMException("Stream range cancelled", "AbortError");
      if (received >= length) break;
      const remaining = length - received;
      const bytes = Uint8Array.from(chunk.subarray(0, remaining));
      chunks.push(bytes);
      received += bytes.byteLength;
    }
    const result = new Uint8Array(received);
    let position = 0;
    for (const chunk of chunks) {
      result.set(chunk, position);
      position += chunk.byteLength;
    }
    return result;
  }

  private async waitForServiceWorkerController() {
    const current = navigator.serviceWorker.controller;
    if (current && await this.supportsProgressivePlayback(current)) return current;
    return new Promise<ServiceWorker | null>((resolve) => {
      const timer = window.setTimeout(async () => {
        navigator.serviceWorker.removeEventListener("controllerchange", changed);
        const controller = navigator.serviceWorker.controller;
        resolve(controller && await this.supportsProgressivePlayback(controller) ? controller : null);
      }, 5000);
      const changed = async () => {
        const controller = navigator.serviceWorker.controller;
        if (!controller || !await this.supportsProgressivePlayback(controller)) return;
        window.clearTimeout(timer);
        navigator.serviceWorker.removeEventListener("controllerchange", changed);
        resolve(controller);
      };
      navigator.serviceWorker.addEventListener("controllerchange", changed);
    });
  }

  private supportsProgressivePlayback(controller: ServiceWorker) {
    return new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => resolve(false), 750);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timer);
        resolve(event.data?.type === "telegram-stream-ready");
      };
      controller.postMessage({ type: "telegram-stream-ping" }, [channel.port2]);
    });
  }

  async upload(
    channel: CloudChannel,
    file: File,
    onProgress: (value: number) => void,
    signal: AbortSignal,
    uploadName = file.name,
  ) {
    if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
    const progress = ((value: number) => onProgress(Math.max(0, Math.min(1, value)))) as ((value: number) => void) & {
      isCanceled?: boolean;
    };
    signal.addEventListener("abort", () => {
      progress.isCanceled = true;
    }, { once: true });
    const name = safeFileName(uploadName, "unnamed");
    const kind = uploadKind(file);
    const client = this.requiredClient();
    // Use the real picker File here. Unpatched Teleproto understands it as a
    // compatibility fallback; the production transform upgrades reads to
    // bounded Blob slices. sendFile only receives Telegram's own InputFile.
    const uploaded = await client.uploadFile({
      file,
      // Telegram still requires each file to be uploaded separately, but its
      // file API explicitly supports several parts in flight. Three keeps the
      // browser memory window small while avoiding a fully serial part stream.
      workers: UPLOAD_PART_WORKERS,
      onProgress: progress,
    });
    if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
    return client.sendFile(channel.inputEntity, {
      file: uploaded,
      fileSize: file.size,
      attributes: uploadAttributes(file, kind).map((attribute) => attribute instanceof Api.DocumentAttributeFilename
        ? new Api.DocumentAttributeFilename({ fileName: name })
        : attribute),
      // A drive must retain the original image bytes. Sending JPEG/PNG as a
      // Telegram photo would recompress it and discard the original filename.
      forceDocument: kind === "image",
      supportsStreaming: kind === "video" && (file.type === "video/mp4" || ["m4v", "mp4"].includes(fileExtension(file.name))),
    });
  }

  async writeSyncCheckpoint(channel: CloudChannel, checkpoint: {
    batchId: string;
    fileCount: number;
    totalBytes: number;
    sourceOldest?: number;
    sourceNewest?: number;
    completedAt: number;
  }) {
    const message = [
      "UCS_SYNC_V1",
      JSON.stringify({
        type: "ucs.sync.v1",
        batch_id: checkpoint.batchId,
        status: "committed",
        file_count: checkpoint.fileCount,
        total_bytes: checkpoint.totalBytes,
        source_oldest: checkpoint.sourceOldest ? new Date(checkpoint.sourceOldest).toISOString() : undefined,
        source_newest: checkpoint.sourceNewest ? new Date(checkpoint.sourceNewest).toISOString() : undefined,
        completed_at: new Date(checkpoint.completedAt).toISOString(),
      }),
    ].join("\n");
    await withTimeout(
      this.requiredClient().sendMessage(channel.inputEntity, { message }),
      TELEGRAM_REQUEST_TIMEOUT,
      "Telegram took too long to save the sync checkpoint. It will be retried later.",
    );
  }

  async delete(channel: CloudChannel, item: CloudItem) {
    await this.requiredClient().deleteMessages(channel.inputEntity, [item.id], { revoke: true });
    await localStore.deleteThumbnail(thumbnailCacheKey(item.channelId, item.id));
    this.messageCache.delete(`${channel.id}:${item.id}`);
  }

  async deleteMany(channel: CloudChannel, items: CloudItem[]) {
    for (let index = 0; index < items.length; index += 100) {
      const chunk = items.slice(index, index + 100);
      await this.requiredClient().deleteMessages(channel.inputEntity, chunk.map((item) => item.id), { revoke: true });
      await Promise.all(chunk.map((item) => localStore.deleteThumbnail(thumbnailCacheKey(item.channelId, item.id)).catch(() => undefined)));
      for (const item of chunk) this.messageCache.delete(`${channel.id}:${item.id}`);
    }
  }

  private async getMessage(channel: CloudChannel, id: number) {
    const key = `${channel.id}:${id}`;
    const cached = this.messageCache.get(key);
    if (cached) {
      this.messageCache.delete(key);
      this.messageCache.set(key, cached);
      return cached;
    }
    const messages = await withTimeout(
      this.requiredClient().getMessages(channel.inputEntity, { ids: id }),
      TELEGRAM_REQUEST_TIMEOUT,
      "Telegram took too long to open this file. Try again.",
    );
    const message = Array.from(messages as any[])[0];
    if (!message) throw new Error("This file is no longer available in the Telegram channel.");
    this.rememberMessage(channel.id, id, message);
    return message;
  }

  private rememberMessage(channelId: string, id: number, message: any) {
    const key = `${channelId}:${id}`;
    this.messageCache.delete(key);
    this.messageCache.set(key, message);
    while (this.messageCache.size > 300) {
      const oldest = this.messageCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.messageCache.delete(oldest);
    }
  }

  private toCloudItem(message: any, channelId: string): CloudItem | undefined {
    if (!message?.media || (!message.photo && !message.document)) return undefined;
    const file = message.file;
    const mime = file?.mimeType || message.document?.mimeType || (message.photo ? "image/jpeg" : "application/octet-stream");
    const fallbackExtension = message.photo ? ".jpg" : "";
    // Teleproto's file.name can be empty for older Telegram documents even
    // when Telegram includes the original filename in DocumentAttributeFilename.
    const attributes = message.document?.attributes || message.media?.document?.attributes || [];
    const attributeName = Array.from(attributes as any[]).find((attribute: any) =>
      attribute instanceof Api.DocumentAttributeFilename || attribute?.className === "DocumentAttributeFilename" || attribute?.constructor?.name === "DocumentAttributeFilename"
    ) as any;
    const telegramAttributeName = attributeName?.fileName || attributeName?.file_name;
    const mimeExtension = mime.match(/^(?:application|audio|image|video)\\/([a-z0-9.+-]+)/i)?.[1]?.replace("pdf", "pdf");
    const fallbackMimeExtension = mime === "application/pdf" ? ".pdf" : mime === "application/zip" ? ".zip" : "";
    const name = safeFileName(file?.name || telegramAttributeName, `file-${message.id}${fallbackExtension || fallbackMimeExtension}`);
    const extension = fileExtension(name);
    const kind: ItemKind = message.photo || mime.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)
      ? "image"
      : message.video || mime.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)
        ? "video"
        : message.audio || mime.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)
          ? "audio"
          : "file";
    const timestamp = asNumber(message.date);
    const duration = asNumber(message.video?.duration ?? message.audio?.duration);
    return {
      id: Number(message.id),
      channelId,
      name: file?.name ? name : `${kind}-${message.id}${fallbackExtension}`,
      kind,
      mime,
      size: asNumber(file?.size),
      // Teleproto 1.228's file.duration getter passes a constructor array to
      // instanceof. Read the concrete media attribute instead.
      duration: duration || undefined,
      date: new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000),
    };
  }

  private requiredClient() {
    if (!this.client) throw new Error("Telegram is not connected.");
    return this.client;
  }

  private requiredCredentials() {
    if (!this.credentials) throw new Error("Telegram API credentials are missing.");
    return this.credentials;
  }
}

export const telegramDrive = new TelegramDrive();
