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
  message: any;
}

export interface HistoryPage {
  items: CloudItem[];
  nextOffset: number;
  hasMore: boolean;
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
const UNSAFE_FILE_NAME_CHARACTERS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);
const VIDEO_EXTENSIONS = new Set(["3g2", "3gp", "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm", "wmv"]);
const AUDIO_EXTENSIONS = new Set(["aac", "aiff", "alac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "wma"]);

const safeFileName = (value: unknown, fallback: string) => {
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
        const uri = `tg://login?token=${token.toString("base64url")}`;
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
    };
  }

  async getHistory(channel: CloudChannel, offsetId = 0, limit = 40): Promise<HistoryPage> {
    const messages = await withTimeout(
      this.requiredClient().getMessages(channel.inputEntity, {
        limit,
        offsetId: offsetId || undefined,
      }),
      TELEGRAM_REQUEST_TIMEOUT,
      "Telegram took too long to load this part of the channel history. Try again.",
    );
    const raw = Array.from(messages as any[]);
    const items = raw.flatMap((message: any) => {
      const item = this.toCloudItem(message, channel.id);
      return item ? [item] : [];
    });
    const ids = raw.map((message: any) => Number(message.id)).filter(Number.isFinite);
    return {
      items,
      nextOffset: ids.length ? Math.min(...ids) : offsetId,
      hasMore: raw.length === limit && ids.length > 0 && Math.min(...ids) !== offsetId,
    };
  }

  async getThumbnail(item: CloudItem): Promise<Blob | undefined> {
    const key = `${item.channelId}:${item.id}`;
    const cached = await localStore.getThumbnail(key);
    if (cached) return cached;
    if (item.kind !== "image" && item.kind !== "video") return undefined;
    const data = await this.requiredClient().downloadMedia(item.message, {
      thumb: 0,
      requestTimeout: TELEGRAM_REQUEST_TIMEOUT,
    });
    const blob = toBlob(data, "image/jpeg");
    if (blob) await localStore.saveThumbnail(key, blob);
    return blob;
  }

  async download(item: CloudItem, onProgress?: (value: number) => void, signal?: AbortSignal) {
    const data = await this.requiredClient().downloadMedia(item.message, {
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
    item: CloudItem,
    write: (chunk: Uint8Array<ArrayBuffer>) => Promise<void>,
    onProgress?: (value: number) => void,
    signal?: AbortSignal,
  ) {
    await this.requiredClient().downloadMedia(item.message, {
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

  async upload(
    channel: CloudChannel,
    file: File,
    onProgress: (value: number) => void,
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
    const progress = ((value: number) => onProgress(Math.max(0, Math.min(1, value)))) as ((value: number) => void) & {
      isCanceled?: boolean;
    };
    signal.addEventListener("abort", () => {
      progress.isCanceled = true;
    }, { once: true });
    // Teleproto 1.228 declares browser File support, but its generic-media
    // guard currently consumes File instances before its upload branch. A
    // non-enumerable marker routes a fresh File clone into the intended branch;
    // the Vite compatibility transform then reads bounded Blob slices.
    const name = safeFileName(file.name, "unnamed");
    const kind = uploadKind(file);
    const browserFile = new File([file], name, {
      type: file.type,
      lastModified: file.lastModified,
    }) as File & { read?: never };
    Object.defineProperty(browserFile, "read", {
      configurable: true,
      enumerable: false,
      value: undefined,
    });
    return this.requiredClient().sendFile(channel.inputEntity, {
      file: browserFile,
      fileSize: file.size,
      attributes: uploadAttributes(browserFile, kind),
      // A drive must retain the original image bytes. Sending JPEG/PNG as a
      // Telegram photo would recompress it and discard the original filename.
      forceDocument: kind === "image",
      supportsStreaming: kind === "video" && (file.type === "video/mp4" || ["m4v", "mp4"].includes(fileExtension(file.name))),
      workers: 1,
      progressCallback: progress,
    });
  }

  async delete(channel: CloudChannel, item: CloudItem) {
    await this.requiredClient().deleteMessages(channel.inputEntity, [item.id], { revoke: true });
    await localStore.deleteThumbnail(`${item.channelId}:${item.id}`);
  }

  private toCloudItem(message: any, channelId: string): CloudItem | undefined {
    if (!message?.media || (!message.photo && !message.document)) return undefined;
    const file = message.file;
    const mime = file?.mimeType || (message.photo ? "image/jpeg" : "application/octet-stream");
    const kind: ItemKind = message.photo || mime.startsWith("image/")
      ? "image"
      : message.video || mime.startsWith("video/")
        ? "video"
        : message.audio || mime.startsWith("audio/")
          ? "audio"
          : "file";
    const extension = message.photo ? ".jpg" : "";
    const timestamp = asNumber(message.date);
    const duration = asNumber(message.video?.duration ?? message.audio?.duration);
    return {
      id: Number(message.id),
      channelId,
      name: safeFileName(file?.name, `${kind}-${message.id}${extension}`),
      kind,
      mime,
      size: asNumber(file?.size),
      // Teleproto 1.228's file.duration getter passes a constructor array to
      // instanceof. Read the concrete media attribute instead.
      duration: duration || undefined,
      date: new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000),
      message,
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
