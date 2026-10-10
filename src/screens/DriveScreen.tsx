import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type SyntheticEvent } from "react";
import {
  CalendarIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CloudIcon,
  DownloadIcon,
  EditIcon,
  FileIcon,
  FolderIcon,
  GridIcon,
  ImageIcon,
  MoreIcon,
  MusicIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  TrashIcon,
  UploadIcon,
  VideoIcon,
} from "../icons";
import {
  localStore,
  type UploadBatchRecord,
  type UploadQueueRecord,
  type UploadQueueStatus,
  type GalleryMetadata,
  type SavedAlbum,
} from "../storage";
import {
  telegramDrive,
  safeFileName,
  type CloudChannel,
  type CloudItem,
  type ItemKind,
} from "../telegram";
import { Brand } from "./Brand";
import { InsightsPanel } from "./InsightsPanel";
import { formatDate, formatSize, friendlyError, userName, type Theme } from "./shared";

type Filter = "all" | ItemKind;
type SortOrder = "newest" | "oldest";

interface NativeFileWritable {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface NativeFileHandle {
  createWritable(): Promise<NativeFileWritable>;
}

interface NativeReadableFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

interface NativeDirectoryHandle {
  kind?: "directory";
  name?: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<NativeFileHandle>;
  values?: () => AsyncIterableIterator<NativeDirectoryHandle | NativeReadableFileHandle>;
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<NativeFileHandle>;
  showDirectoryPicker?: () => Promise<NativeDirectoryHandle>;
};

const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
const formatMonth = (date: Date) => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
const dateFromFileName = (name: string) => {
  // Covers the app's YYYY-MM-DD__ prefix plus common IMG_20240817 and
  // Screenshot_2024-08-17 forms. Only inspect the beginning of a name and
  // fall back cleanly instead of trying to understand every camera format.
  const candidate = name.slice(0, 96);
  const fullDate = candidate.match(/(?:^|[^\d])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?=[^\d]|$)/);
  const monthOnly = fullDate ? undefined : candidate.match(/(?:^|[^\d])((?:19|20)\d{2})[-_.](0[1-9]|1[0-2])(?=[^\d]|$)/);
  const match = fullDate || monthOnly;
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = fullDate ? Number(match[3]) : 1;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : undefined;
};

const DIRECT_SAVE_THRESHOLD = 750 * 1024 * 1024;
const MAX_UPLOAD_ATTEMPTS = 5;
const UPLOAD_STALL_TIMEOUT = 2 * 60 * 1000;
const DIRECTORY_ENQUEUE_BATCH_SIZE = 100;
const previewLimitMb = (effectiveMemoryMb: number) => {
  if (effectiveMemoryMb <= 256) return 128;
  if (effectiveMemoryMb <= 512) return 384;
  if (effectiveMemoryMb <= 1024) return 768;
  return Math.min(1536, Math.floor(effectiveMemoryMb * .75));
};


const selectedRelativePaths = new WeakMap<File, string>();

const fileFingerprint = (channelId: string, file: File) => {
  const relativePath = selectedRelativePaths.get(file) || (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
  const fingerprint = [relativePath, file.name, file.size, file.lastModified].join("\u0000");
  return { id: `${channelId}\u0000${fingerprint}`, fingerprint, relativePath };
};

async function* readDirectoryRecursively(directory: NativeDirectoryHandle, parentPath = ""): AsyncGenerator<File> {
  if (!directory.values) return;
  const directoryPath = directory.name ? [parentPath, directory.name].filter(Boolean).join("/") : parentPath;
  for await (const entry of directory.values()) {
    if (entry.kind === "file") {
      const file = await entry.getFile();
      selectedRelativePaths.set(file, [directoryPath, entry.name].filter(Boolean).join("/"));
      yield file;
    } else {
      yield* readDirectoryRecursively(entry, directoryPath);
    }
  }
}

const fileResumeKey = (file: Pick<File, "name" | "size" | "lastModified">) => [file.name, file.size, file.lastModified].join("\u0000");

const uploadRecordResumeKey = (record: UploadQueueRecord) => [record.sourceName || record.name, record.size, record.lastModified].join("\u0000");

const normalizedUploadName = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase();
const isHeicItem = (item: Pick<CloudItem, "name" | "mime">) => /image\/(?:hei[cf]|heic-sequence|heif-sequence)/i.test(item.mime) || /\.hei[cf]$/i.test(item.name);
const EXIF_DATE_EXTENSIONS = new Set(["avif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff"]);
let exifrModule: Promise<typeof import("exifr")> | undefined;

const decodeHeicPreview = async (blob: Blob) => {
  const { heicTo } = await import("heic-to/csp");
  return heicTo({ blob, type: "image/jpeg", quality: .9 });
};

const validMediaDate = (value: unknown) => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string") return undefined;
  const parts = value.match(/^((?:19|20)\d{2})[:-](0[1-9]|1[0-2])[:-](0[1-9]|[12]\d|3[01])[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!parts) return undefined;
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6]));
  return Number.isFinite(date.getTime()) ? date : undefined;
};

const supportsEmbeddedMediaDate = (file: File) => {
  const extension = file.name.toLocaleLowerCase().match(/\.([^.]+)$/)?.[1] || "";
  return EXIF_DATE_EXTENSIONS.has(extension) || /image\/(?:avif|hei[cf]|jpeg|png|tiff?)/i.test(file.type);
};

const embeddedMediaDate = async (file: File) => {
  if (!supportsEmbeddedMediaDate(file)) return undefined;
  try {
    exifrModule ||= import("exifr");
    const exifr = await exifrModule;
    const metadata = await exifr.parse(file, ["DateTimeOriginal", "CreateDate", "DateTimeDigitized"]);
    return validMediaDate(metadata?.DateTimeOriginal)
      || validMediaDate(metadata?.CreateDate)
      || validMediaDate(metadata?.DateTimeDigitized);
  } catch {
    // Some edited/exported images contain no readable capture metadata.
    return undefined;
  }
};

const datePrefixedName = async (file: File) => {
  if (/^\d{4}-\d{2}-\d{2}__/.test(file.name)) return file.name;
  const date = await embeddedMediaDate(file)
    || dateFromFileName(file.name)
    || (file.lastModified > 0 ? new Date(file.lastModified) : undefined);
  if (!date || !Number.isFinite(date.getTime())) return file.name;
  const prefix = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  return `${prefix}__${file.name}`;
};

const safeDownloadName = (name: string) => {
  const leaf = name.split(/[\\/]/).pop() || "file";
  return leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240) || "file";
};

const uniqueDownloadName = (name: string, used: Set<string>) => {
  const safeName = safeDownloadName(name);
  const dot = safeName.lastIndexOf(".");
  const base = dot > 0 ? safeName.slice(0, dot) : safeName;
  const extension = dot > 0 ? safeName.slice(dot) : "";
  let candidate = safeName;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase())) candidate = `${base} (${suffix++})${extension}`;
  used.add(candidate.toLocaleLowerCase());
  return candidate;
};

const formatRemainingTime = (milliseconds: number) => {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `about ${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""} left`;
  const days = Math.ceil(hours / 24);
  return `about ${days} ${days === 1 ? "day" : "days"} left`;
};

const formatCountdown = (milliseconds: number) => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainingSeconds = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
};

const retryDelay = (attempt: number) => Math.min(30_000, 1_000 * 3 ** Math.max(0, attempt - 1));

const telegramRateLimitSeconds = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/FLOOD_(?:PREMIUM_)?WAIT_?(\d+)/i)
    || raw.match(/please\s+wait\s+(\d+)\s+seconds?/i)
    || raw.match(/wait(?:ing)?(?:\s+of|\s+for)?\s+(\d+)\s+seconds?/i);
  const seconds = Number(match?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

const telegramRetryDelay = (attempt: number) => retryDelay(attempt);

const waitFor = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new DOMException("Upload paused", "AbortError"));
  const timer = window.setTimeout(done, milliseconds);
  function done() {
    signal.removeEventListener("abort", cancelled);
    resolve();
  }
  function cancelled() {
    window.clearTimeout(timer);
    reject(new DOMException("Upload paused", "AbortError"));
  }
  signal.addEventListener("abort", cancelled, { once: true });
});

const waitForOnline = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new DOMException("Upload paused", "AbortError"));
  if (navigator.onLine) return resolve();
  const online = () => finish(resolve);
  const cancelled = () => finish(() => reject(new DOMException("Upload paused", "AbortError")));
  const finish = (done: () => void) => {
    window.removeEventListener("online", online);
    signal.removeEventListener("abort", cancelled);
    done();
  };
  window.addEventListener("online", online, { once: true });
  signal.addEventListener("abort", cancelled, { once: true });
});

const uploadStatusBucket = (status: UploadQueueStatus) => {
  if (status === "done") return "done" as const;
  if (status === "failed") return "failed" as const;
  if (status === "needs-file") return "needsFile" as const;
  return "pending" as const;
};

interface UploadRecentEntry { id: string; name: string; status: UploadQueueStatus; error?: string }
interface UploadSnapshot {
  total: number;
  pending: number;
  done: number;
  failed: number;
  needsFile: number;
  skipped: number;
  duplicatesSkipped: number;
  paused: boolean;
  currentName?: string;
  currentProgress: number;
  currentAttempt: number;
  runStartedAt?: number;
  runStartedProcessed: number;
  rateLimitStartedAt?: number;
  rateLimitUntil?: number;
  recent: UploadRecentEntry[];
}
interface DownloadEntry { name: string; progress: number }

const emptyUploadSnapshot = (): UploadSnapshot => ({
  total: 0,
  pending: 0,
  done: 0,
  failed: 0,
  needsFile: 0,
  skipped: 0,
  duplicatesSkipped: 0,
  paused: false,
  currentProgress: 0,
  currentAttempt: 0,
  runStartedProcessed: 0,
  recent: [],
});

export function DriveScreen({ account, channel, channels, showPublicChannels, theme, onShowPublicChannels, onSelectChannel, onCreateChannel, onRenameChannel, onDeleteChannel, onChangeChannel, onForget, onLogOut, onHome, onTheme }: {
  account: any;
  channel: CloudChannel;
  channels: CloudChannel[];
  showPublicChannels: boolean;
  theme: Theme;
  onShowPublicChannels: (value: boolean) => void;
  onSelectChannel: (channel: CloudChannel) => Promise<void>;
  onCreateChannel: (title: string) => Promise<CloudChannel>;
  onRenameChannel: (channel: CloudChannel, title: string) => Promise<CloudChannel>;
  onDeleteChannel: (channel: CloudChannel) => Promise<void>;
  onChangeChannel: () => void;
  onForget: () => Promise<void>;
  onLogOut: () => Promise<void>;
  onHome: () => void;
  onTheme: (theme: Theme) => Promise<void>;
}) {
  const [items, setItems] = useState<CloudItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [groupByMonth, setGroupByMonth] = useState(true);
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [memoryLimitMb, setMemoryLimitMb] = useState(1024);
  const [preventDuplicateNames, setPreventDuplicateNames] = useState(false);
  const [datePrefixUploads, setDatePrefixUploads] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CloudItem>();
  const [selectionMode, setSelectionMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState("");
  const [faceBusy, setFaceBusy] = useState(false);
  const [faceMessage, setFaceMessage] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [activeAlbumId, setActiveAlbumId] = useState<string>();
  const [galleryMetadata, setGalleryMetadata] = useState<GalleryMetadata>({ favoriteIds: [], verifiedIds: [], albums: [] });
  const [uploadSnapshot, setUploadSnapshot] = useState<UploadSnapshot>(emptyUploadSnapshot);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [showSyncChooser, setShowSyncChooser] = useState(false);
  const [downloadEntry, setDownloadEntry] = useState<DownloadEntry>();
  const [dragging, setDragging] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const fileInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | undefined>(undefined);
  const uploadRecords = useRef(new Map<string, UploadQueueRecord>());
  const uploadBatches = useRef(new Map<string, UploadBatchRecord>());
  const uploadFiles = useRef(new Map<string, File>());
  const uploadOrder = useRef<string[]>([]);
  const uploadOrderSet = useRef(new Set<string>());
  const uploadVisibleIds = useRef(new Set<string>());
  const uploadStats = useRef(emptyUploadSnapshot());
  const uploadRunning = useRef(false);
  const uploadPaused = useRef(false);
  const uploadMounted = useRef(true);
  const uploadLastPaint = useRef(0);
  const uploadRestore = useRef<Promise<void>>(Promise.resolve());
  const uploadEnqueue = useRef<Promise<void>>(Promise.resolve());
  const downloadAbort = useRef<AbortController | undefined>(undefined);
  const bulkCancelRequested = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const historyRequestRef = useRef<string | undefined>(undefined);
  const activeHistoryKeyRef = useRef(`${channel.id}:${sortOrder}`);
  activeHistoryKeyRef.current = `${channel.id}:${sortOrder}`;
  const reportedDeviceMemory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  const effectiveMemoryMb = reportedDeviceMemory > 0 ? Math.min(memoryLimitMb, reportedDeviceMemory * 256) : memoryLimitMb;
  const previewLimitBytes = previewLimitMb(effectiveMemoryMb) * 1024 * 1024;

  const load = useCallback(async (reset = false) => {
    const requestedKey = `${channel.id}:${sortOrder}`;
    if (historyRequestRef.current === requestedKey) return;
    historyRequestRef.current = requestedKey;
    const requestedChannel = channel;
    const requestedOffset = reset ? 0 : offsetRef.current;
    reset ? setLoading(true) : setLoadingMore(true);
    setError("");
    try {
      const page = await telegramDrive.getHistory(requestedChannel, requestedOffset, 100, sortOrder === "oldest");
      if (activeHistoryKeyRef.current !== requestedKey) return;
      setItems((current) => reset ? page.items : [...current, ...page.items.filter((item) => !current.some((old) => old.id === item.id))]);
      offsetRef.current = page.nextOffset;
      setHasMore(page.hasMore);
    } catch (cause) {
      if (activeHistoryKeyRef.current === requestedKey) setError(friendlyError(cause));
    } finally {
      if (historyRequestRef.current === requestedKey) historyRequestRef.current = undefined;
      if (activeHistoryKeyRef.current === requestedKey) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [channel, sortOrder]);

  useEffect(() => {
    let active = true;
    setGalleryMetadata({ favoriteIds: [], verifiedIds: [], albums: [] });
    setFavoritesOnly(false);
    setActiveAlbumId(undefined);
    void localStore.getGalleryMetadata(channel.id).then((metadata) => { if (active) setGalleryMetadata(metadata); }).catch(() => undefined);
    return () => { active = false; };
  }, [channel.id]);

  useEffect(() => {
    setItems([]);
    setSelectionMode(false);
    setCheckedIds(new Set());
    offsetRef.current = 0;
    setHasMore(true);
    void load(true);
  }, [channel.id, load]);
  useEffect(() => {
    void Promise.all([
      localStore.getMemoryLimitMb(),
      localStore.getPreventDuplicateNames(),
      localStore.getDatePrefixUploads(),
    ]).then(([memory, preventDuplicates, prefixDates]) => {
      setMemoryLimitMb(memory);
      setPreventDuplicateNames(preventDuplicates);
      setDatePrefixUploads(prefixDates);
    });
  }, []);
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []);
  useEffect(() => {
    const target = sentinel.current;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && hasMore && !loading && !loadingMore && !selected) void load(false);
    }, { rootMargin: "300px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, load, loading, loadingMore, selected]);

  // Search, favorites and albums scan remaining history pages so their results
  // are not limited to the currently rendered page. Only lightweight metadata is retained.
  useEffect(() => {
    if ((search.trim() || favoritesOnly || activeAlbumId) && hasMore && !loading && !loadingMore && !selected) void load(false);
  }, [hasMore, load, loading, loadingMore, search, selected, favoritesOnly, activeAlbumId]);

  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const favoriteSet = new Set(galleryMetadata.favoriteIds);
    const album = galleryMetadata.albums.find((entry) => entry.id === activeAlbumId);
    const albumSet = album ? new Set(album.itemIds) : undefined;
    return items.filter((item) => (filter === "all" || item.kind === filter) && (!query || item.name.toLocaleLowerCase().includes(query)) && (!favoritesOnly || favoriteSet.has(item.id)) && (!albumSet || albumSet.has(item.id)));
  }, [items, filter, search, galleryMetadata, favoritesOnly, activeAlbumId]);

  const publishUploadSnapshot = useCallback((force = false) => {
    const now = Date.now();
    if (!force && now - uploadLastPaint.current < 180) return;
    uploadLastPaint.current = now;
    const stats = uploadStats.current;
    if (uploadMounted.current) setUploadSnapshot({ ...stats, recent: [...stats.recent] });
  }, []);

  useEffect(() => {
    if (!uploadSnapshot.pending || uploadSnapshot.paused || !uploadSnapshot.runStartedAt) return;
    const timer = window.setInterval(() => publishUploadSnapshot(true), 1_000);
    return () => window.clearInterval(timer);
  }, [publishUploadSnapshot, uploadSnapshot.paused, uploadSnapshot.pending, uploadSnapshot.runStartedAt]);

  const activateUploadRecord = (record: UploadQueueRecord) => {
    if (uploadVisibleIds.current.has(record.id)) return;
    uploadVisibleIds.current.add(record.id);
    uploadStats.current.total += 1;
    uploadStats.current[uploadStatusBucket(record.status)] += 1;
  };

  const updateUploadRecord = async (record: UploadQueueRecord, status: UploadQueueStatus, error?: string) => {
    const previous = uploadStatusBucket(record.status);
    const next = uploadStatusBucket(status);
    if (uploadVisibleIds.current.has(record.id) && previous !== next) {
      uploadStats.current[previous] -= 1;
      uploadStats.current[next] += 1;
    }
    record.status = status;
    record.error = error;
    if (status === "done") record.completedAt = Date.now();
    uploadRecords.current.set(record.id, record);
    if (status === "done" || status === "failed" || status === "retrying") {
      uploadStats.current.recent = [
        { id: record.id, name: record.name, status, error },
        ...uploadStats.current.recent.filter((entry) => entry.id !== record.id),
      ].slice(0, 6);
    }
    await localStore.saveUploadRecord(record);
    publishUploadSnapshot(true);
  };

  const finalizeReadyBatches = async () => {
    for (const batch of uploadBatches.current.values()) {
      if (batch.checkpointSent) continue;
      const records = await localStore.getUploadBatchRecords(batch.id);
      if (records.length !== batch.fileCount || records.some((record) => record.status !== "done")) continue;
      const completedAt = records.reduce((latest, record) => Math.max(latest, record.completedAt || 0), Date.now());
      try {
        await telegramDrive.writeSyncCheckpoint(channel, { ...batch, completedAt, batchId: batch.id });
        const completed: UploadBatchRecord = { ...batch, status: "completed", completedAt, checkpointSent: true };
        uploadBatches.current.set(batch.id, completed);
        await localStore.saveUploadBatch(completed);
      } catch (cause) {
        setError(`Files uploaded, but the sync checkpoint will be retried later: ${friendlyError(cause)}`);
      }
    }
  };

  const queueUploadId = (id: string, first = false) => {
    if (uploadOrderSet.current.has(id)) return;
    uploadOrderSet.current.add(id);
    first ? uploadOrder.current.unshift(id) : uploadOrder.current.push(id);
  };

  const processUploadQueue = async () => {
    if (uploadRunning.current || uploadPaused.current) return;
    uploadRunning.current = true;
    uploadStats.current.paused = false;
    publishUploadSnapshot(true);
    try {
      while (!uploadPaused.current) {
        const id = uploadOrder.current.shift();
        if (!id) break;
        uploadOrderSet.current.delete(id);
        const record = uploadRecords.current.get(id);
        const file = uploadFiles.current.get(id);
        if (!record || record.status === "done") continue;
        if (!file) {
          await updateUploadRecord(record, "needs-file", "Select this file again to resume.");
          continue;
        }

        let uploaded = false;
        for (let attempt = Math.max(1, record.attempts + 1); attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
          if (uploadPaused.current) break;
          record.attempts = attempt;
          const controller = new AbortController();
          uploadAbort.current = controller;
          let stalled = false;
          let stallTimer = 0;
          const armStallTimer = () => {
            window.clearTimeout(stallTimer);
            stallTimer = window.setTimeout(() => {
              stalled = true;
              controller.abort();
            }, UPLOAD_STALL_TIMEOUT);
          };
          uploadStats.current.currentName = record.name;
          uploadStats.current.currentProgress = 0;
          uploadStats.current.currentAttempt = attempt;
          await updateUploadRecord(record, attempt === 1 ? "uploading" : "retrying", attempt > 1 ? `Attempt ${attempt} of ${MAX_UPLOAD_ATTEMPTS}` : undefined);
          armStallTimer();
          try {
            await telegramDrive.upload(channel, file, (progress) => {
              armStallTimer();
              uploadStats.current.currentProgress = progress;
              publishUploadSnapshot();
            }, controller.signal, record.name);
            window.clearTimeout(stallTimer);
            await updateUploadRecord(record, "done");
            uploadFiles.current.delete(id);
            uploaded = true;
            break;
          } catch (cause) {
            window.clearTimeout(stallTimer);
            if (uploadPaused.current) {
              record.attempts = Math.max(0, attempt - 1);
              await updateUploadRecord(record, "queued");
              queueUploadId(id, true);
              break;
            }
            const message = stalled ? "Upload stopped making progress." : friendlyError(cause);
            const rateLimitSeconds = telegramRateLimitSeconds(cause);
            if (rateLimitSeconds) {
              record.attempts = Math.max(0, attempt - 1);
              const startedAt = Date.now();
              const until = startedAt + rateLimitSeconds * 1000;
              uploadStats.current.rateLimitStartedAt = startedAt;
              uploadStats.current.rateLimitUntil = until;
              await updateUploadRecord(record, "retrying", `Telegram rate limit. Waiting ${rateLimitSeconds.toLocaleString()} seconds without using a retry attempt.`);
              const cooldownController = new AbortController();
              uploadAbort.current = cooldownController;
              try {
                await waitFor(Math.max(0, until - Date.now()), cooldownController.signal);
                uploadStats.current.rateLimitStartedAt = undefined;
                uploadStats.current.rateLimitUntil = undefined;
                publishUploadSnapshot(true);
                attempt -= 1;
                continue;
              } catch {
                uploadStats.current.rateLimitStartedAt = undefined;
                uploadStats.current.rateLimitUntil = undefined;
                await updateUploadRecord(record, "queued");
                queueUploadId(id, true);
                break;
              }
            }
            if (!navigator.onLine) {
              record.attempts = Math.max(0, attempt - 1);
              await updateUploadRecord(record, "retrying", "Waiting for an internet connection. This does not use a retry attempt.");
              const onlineController = new AbortController();
              uploadAbort.current = onlineController;
              try {
                await waitForOnline(onlineController.signal);
                attempt -= 1;
                continue;
              } catch {
                await updateUploadRecord(record, "queued");
                queueUploadId(id, true);
                break;
              }
            }
            if (attempt < MAX_UPLOAD_ATTEMPTS) {
              const delay = telegramRetryDelay(attempt);
              await updateUploadRecord(record, "retrying", `${message} Retrying in ${Math.round(delay / 1000)}s.`);
              const delayController = new AbortController();
              uploadAbort.current = delayController;
              try {
                await waitFor(delay, delayController.signal);
              } catch {
                await updateUploadRecord(record, "queued");
                queueUploadId(id, true);
                break;
              }
            } else {
              await updateUploadRecord(record, "failed", `${message} Tried ${MAX_UPLOAD_ATTEMPTS} times.`);
            }
          }
        }
        if (!uploaded && uploadPaused.current) break;
      }
    } finally {
      uploadAbort.current = undefined;
      uploadRunning.current = false;
      uploadStats.current.currentName = undefined;
      uploadStats.current.currentProgress = 0;
      uploadStats.current.currentAttempt = 0;
      uploadStats.current.rateLimitStartedAt = undefined;
      uploadStats.current.rateLimitUntil = undefined;
      uploadStats.current.paused = uploadPaused.current;
      publishUploadSnapshot(true);
      await finalizeReadyBatches();
      if (uploadStats.current.done > 0) await load(true);
      if (uploadOrder.current.length && !uploadPaused.current) void processUploadQueue();
    }
  };

  useEffect(() => {
    let active = true;
    uploadMounted.current = true;
    uploadPaused.current = false;
    const restore = (async () => {
      const [records, batches] = await Promise.all([
        localStore.getUploadRecords(channel.id),
        localStore.getUploadBatches(channel.id),
      ]);
      if (!active || !uploadMounted.current) return;
      uploadBatches.current = new Map(batches.map((batch) => [batch.id, batch]));
      const changed: UploadQueueRecord[] = [];
      for (const record of records) {
        if (record.status !== "done") {
          record.status = "needs-file";
          record.error = "Select this file again to resume.";
          changed.push(record);
          activateUploadRecord(record);
        }
        uploadRecords.current.set(record.id, record);
      }
      if (changed.length) {
        await localStore.saveUploadRecords(changed);
        setShowUploadPanel(true);
      }
      publishUploadSnapshot(true);
      await finalizeReadyBatches();
    })();
    uploadRestore.current = restore;
    void restore;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!uploadRunning.current) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      active = false;
      uploadMounted.current = false;
      uploadPaused.current = true;
      uploadAbort.current?.abort();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  // DriveScreen is keyed by channel ID, so this initialization runs once per channel mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  const appendFilesToUploadQueue = async (files: File[]) => {
    await uploadRestore.current;
    const continuingActiveRun = uploadStats.current.pending > 0;

    // Merge persisted state first in case the picker was opened immediately
    // after the drive mounted and queue restoration was still in flight.
    const [persistedRecords, persistedBatches] = await Promise.all([
      localStore.getUploadRecords(channel.id),
      localStore.getUploadBatches(channel.id),
    ]);
    for (const batch of persistedBatches) {
      if (!uploadBatches.current.has(batch.id)) uploadBatches.current.set(batch.id, batch);
    }
    for (const record of persistedRecords) {
      if (uploadRecords.current.has(record.id)) continue;
      uploadRecords.current.set(record.id, record);
      if (record.status !== "done") activateUploadRecord(record);
    }

    const batchId = crypto.randomUUID();
    const now = Date.now();
    const changed: UploadQueueRecord[] = [];
    const newRecords: UploadQueueRecord[] = [];
    const seen = new Set<string>();
    const resumeMatches = new Map<string, UploadQueueRecord | null>();
    const knownUploadNames = new Set(items.map((item) => normalizedUploadName(item.name)));
    for (const record of uploadRecords.current.values()) {
      if (record.channelId !== channel.id) continue;
      const key = uploadRecordResumeKey(record);
      resumeMatches.set(key, resumeMatches.has(key) ? null : record);
      knownUploadNames.add(normalizedUploadName(record.name));
    }
    let skipped = 0;
    let duplicatesSkipped = 0;
    for (const file of files) {
      const identity = fileFingerprint(channel.id, file);
      if (seen.has(identity.id)) continue;
      seen.add(identity.id);
      const directMatch = uploadRecords.current.get(identity.id);
      const fallbackMatch = resumeMatches.get(fileResumeKey(file));
      const existing = directMatch || fallbackMatch || undefined;
      if (existing?.status === "done") {
        skipped += 1;
        continue;
      }
      if (existing && (existing.status === "queued" || existing.status === "uploading" || existing.status === "retrying")) {
        // The same picker item was selected again while its current-page
        // transfer was already queued or active. Do not race a second record
        // write against that upload.
        continue;
      }
      const plannedName = safeFileName(datePrefixUploads ? await datePrefixedName(file) : existing?.name || file.name, "unnamed");
      if (preventDuplicateNames && !existing && knownUploadNames.has(normalizedUploadName(plannedName))) {
        duplicatesSkipped += 1;
        continue;
      }
      const record: UploadQueueRecord = existing ? {
        ...existing,
        sourceName: file.name,
        name: plannedName,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        relativePath: identity.relativePath,
        status: "queued",
        attempts: 0,
        error: undefined,
      } : {
        id: identity.id,
        channelId: channel.id,
        batchId,
        fingerprint: identity.fingerprint,
        sourceName: file.name,
        name: plannedName,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        relativePath: identity.relativePath,
        status: "queued",
        attempts: 0,
        createdAt: now,
      };
      if (existing && uploadVisibleIds.current.has(existing.id)) {
        const previous = uploadStatusBucket(existing.status);
        if (previous !== "pending") {
          uploadStats.current[previous] -= 1;
          uploadStats.current.pending += 1;
        }
      }
      uploadRecords.current.set(record.id, record);
      knownUploadNames.add(normalizedUploadName(record.name));
      uploadFiles.current.set(record.id, file);
      activateUploadRecord(record);
      queueUploadId(record.id);
      changed.push(record);
      if (!existing) newRecords.push(record);
    }

    let newBatch: UploadBatchRecord | undefined;
    if (newRecords.length) {
      const dates = newRecords.map((record) => record.lastModified).filter((value) => value > 0);
      newBatch = {
        id: batchId,
        channelId: channel.id,
        status: "active",
        fileCount: newRecords.length,
        totalBytes: newRecords.reduce((total, record) => total + record.size, 0),
        sourceOldest: dates.length ? dates.reduce((oldest, value) => Math.min(oldest, value), dates[0]) : undefined,
        sourceNewest: dates.length ? dates.reduce((newest, value) => Math.max(newest, value), dates[0]) : undefined,
        createdAt: now,
        checkpointSent: false,
      };
      uploadBatches.current.set(newBatch.id, newBatch);
    }
    if (newBatch) await localStore.saveUploadBatchWithRecords(newBatch, changed);
    else await localStore.saveUploadRecords(changed);
    uploadStats.current.skipped += skipped;
    uploadStats.current.duplicatesSkipped += duplicatesSkipped;
    if (changed.length && !continuingActiveRun) {
      uploadStats.current.runStartedAt = Date.now();
      uploadStats.current.runStartedProcessed = uploadStats.current.done + uploadStats.current.failed;
    }
    publishUploadSnapshot(true);
    if (!uploadPaused.current) void processUploadQueue();
  };

  const handleFiles = (list: FileList | File[]) => {
    // Copy the picker result immediately. Some mobile browsers clear their
    // live FileList as soon as the input is reset or another picker opens.
    const files = Array.from(list);
    setShowSyncChooser(false);
    if (!files.length) return Promise.resolve();
    setShowUploadPanel(true);

    // Native pickers are normally modal, but their change handlers can still
    // overlap with IndexedDB work from the previous selection. Serialize only
    // queue bookkeeping; the upload worker continues independently and newly
    // appended IDs remain FIFO behind anything already waiting.
    uploadEnqueue.current = uploadEnqueue.current
      .then(() => appendFilesToUploadQueue(files))
      .catch((cause) => {
        setError(`Could not add files to the upload queue: ${friendlyError(cause)}`);
      });
    return uploadEnqueue.current;
  };

  const selectDirectory = async () => {
    const picker = (window as SaveFilePickerWindow).showDirectoryPicker;
    if (!picker) {
      directoryInput.current?.click();
      return;
    }
    setShowSyncChooser(false);
    try {
      const directory = await picker();
      let files: File[] = [];
      let found = 0;
      for await (const file of readDirectoryRecursively(directory)) {
        files.push(file);
        found += 1;
        if (files.length === DIRECTORY_ENQUEUE_BATCH_SIZE) {
          await handleFiles(files);
          files = [];
        }
      }
      if (files.length) await handleFiles(files);
      if (!found) setError("That folder does not contain any files.");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(`Could not read that folder: ${friendlyError(cause)}`);
    }
  };

  const pauseUploads = () => {
    uploadPaused.current = true;
    uploadStats.current.paused = true;
    uploadAbort.current?.abort();
    publishUploadSnapshot(true);
  };

  const deleteStorageChannel = async (target: CloudChannel) => {
    if (target.id === channel.id) pauseUploads();
    await onDeleteChannel(target);
  };

  const resumeUploads = async () => {
    const reset: UploadQueueRecord[] = [];
    for (const record of uploadRecords.current.values()) {
      if (!uploadVisibleIds.current.has(record.id) || record.status !== "failed" || !uploadFiles.current.has(record.id)) continue;
      const previous = uploadStatusBucket(record.status);
      record.status = "queued";
      record.attempts = 0;
      record.error = undefined;
      uploadStats.current[previous] -= 1;
      uploadStats.current.pending += 1;
      queueUploadId(record.id);
      reset.push(record);
    }
    await localStore.saveUploadRecords(reset);
    uploadPaused.current = false;
    uploadStats.current.paused = false;
    if (uploadStats.current.pending > 0) {
      uploadStats.current.runStartedAt = Date.now();
      uploadStats.current.runStartedProcessed = uploadStats.current.done + uploadStats.current.failed;
    }
    publishUploadSnapshot(true);
    void processUploadQueue();
  };

  const dismissUnfinishedUploads = async () => {
    const unfinished = Array.from(uploadRecords.current.values()).filter((record) => record.channelId === channel.id && record.status === "needs-file");
    if (!unfinished.length) {
      setShowUploadPanel(false);
      return;
    }
    const unfinishedIds = new Set(unfinished.map((record) => record.id));
    const affectedBatchIds = new Set(unfinished.map((record) => record.batchId));
    await localStore.deleteUploadRecords([...unfinishedIds]);
    for (const record of unfinished) {
      uploadRecords.current.delete(record.id);
      uploadFiles.current.delete(record.id);
      uploadVisibleIds.current.delete(record.id);
      uploadOrderSet.current.delete(record.id);
    }
    uploadOrder.current = uploadOrder.current.filter((id) => !unfinishedIds.has(id));
    uploadStats.current.total = Math.max(0, uploadStats.current.total - unfinished.length);
    uploadStats.current.needsFile = Math.max(0, uploadStats.current.needsFile - unfinished.length);
    uploadStats.current.recent = uploadStats.current.recent.filter((entry) => !unfinishedIds.has(entry.id));

    for (const batchId of affectedBatchIds) {
      const remaining = Array.from(uploadRecords.current.values()).filter((record) => record.batchId === batchId);
      const hasUnfinishedWork = remaining.some((record) => record.status !== "done");
      const batch = uploadBatches.current.get(batchId);
      if (!batch || !remaining.length || !hasUnfinishedWork) {
        uploadBatches.current.delete(batchId);
        await localStore.deleteUploadBatch(batchId);
        continue;
      }
      const dates = remaining.map((record) => record.lastModified).filter((value) => value > 0);
      const updated: UploadBatchRecord = {
        ...batch,
        fileCount: remaining.length,
        totalBytes: remaining.reduce((total, record) => total + record.size, 0),
        sourceOldest: dates.length ? Math.min(...dates) : undefined,
        sourceNewest: dates.length ? Math.max(...dates) : undefined,
      };
      uploadBatches.current.set(batchId, updated);
      await localStore.saveUploadBatch(updated);
    }

    if (!uploadStats.current.total) uploadStats.current = emptyUploadSnapshot();
    publishUploadSnapshot(true);
    setShowUploadPanel(false);
  };

  const openSync = () => {
    setShowSyncChooser(true);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void handleFiles(event.dataTransfer.files);
  };

  const downloadItem = async (item: CloudItem) => {
    downloadAbort.current?.abort();
    const savePicker = (window as SaveFilePickerWindow).showSaveFilePicker;
    let fileHandle: NativeFileHandle | undefined;
    // Let Chrome handle normal downloads itself. The native picker is reserved
    // for very large files, where building a Blob could exhaust browser memory.
    if (item.size > DIRECT_SAVE_THRESHOLD && savePicker) {
      try {
        fileHandle = await savePicker.call(window, { suggestedName: item.name });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(friendlyError(cause));
        return;
      }
    } else if (item.size > DIRECT_SAVE_THRESHOLD && !window.confirm("This browser cannot stream directly to a chosen file. This download may use substantial memory. Continue?")) {
      return;
    }

    const controller = new AbortController();
    downloadAbort.current = controller;
    setDownloadEntry({ name: item.name, progress: 0 });
    setError("");
    try {
      const progress = (value: number) => setDownloadEntry({ name: item.name, progress: value });
      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        try {
          await telegramDrive.downloadTo(channel, item, (chunk) => writable.write(chunk), progress, controller.signal);
          await writable.close();
        } catch (cause) {
          try { await writable.abort(cause); } catch { /* The stream may already be closed. */ }
          throw cause;
        }
      } else {
        const blob = await telegramDrive.download(channel, item, progress, controller.signal);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = item.name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(friendlyError(cause));
    } finally {
      if (downloadAbort.current === controller) {
        downloadAbort.current = undefined;
        setDownloadEntry(undefined);
      }
    }
  };

  const forgetDeletedUploadRecords = async (names: string[]) => {
    const deletedNames = new Set(names.map(normalizedUploadName));
    const records = Array.from(uploadRecords.current.values()).filter((record) => record.status === "done" && deletedNames.has(normalizedUploadName(record.name)));
    if (!records.length) return;
    const ids = new Set(records.map((record) => record.id));
    const affectedBatchIds = new Set(records.map((record) => record.batchId));
    await localStore.deleteUploadRecords([...ids]);
    for (const record of records) {
      uploadRecords.current.delete(record.id);
      uploadFiles.current.delete(record.id);
      if (uploadVisibleIds.current.delete(record.id)) {
        uploadStats.current.total = Math.max(0, uploadStats.current.total - 1);
        uploadStats.current.done = Math.max(0, uploadStats.current.done - 1);
      }
    }
    uploadStats.current.recent = uploadStats.current.recent.filter((entry) => !ids.has(entry.id));
    for (const batchId of affectedBatchIds) {
      const batch = uploadBatches.current.get(batchId);
      if (!batch || batch.checkpointSent) continue;
      const remaining = Array.from(uploadRecords.current.values()).filter((record) => record.batchId === batchId);
      if (!remaining.length) {
        uploadBatches.current.delete(batchId);
        await localStore.deleteUploadBatch(batchId);
        continue;
      }
      const dates = remaining.map((record) => record.lastModified).filter((value) => value > 0);
      const updated = {
        ...batch,
        fileCount: remaining.length,
        totalBytes: remaining.reduce((total, record) => total + record.size, 0),
        sourceOldest: dates.length ? Math.min(...dates) : undefined,
        sourceNewest: dates.length ? Math.max(...dates) : undefined,
      };
      uploadBatches.current.set(batchId, updated);
      await localStore.saveUploadBatch(updated);
    }
    publishUploadSnapshot(true);
  };

  const deleteItem = async (item: CloudItem) => {
    if (!window.confirm(`Permanently delete “${item.name}” from Telegram? This cannot be undone.`)) return;
    try {
      await telegramDrive.delete(channel, item);
      await forgetDeletedUploadRecords([item.name]).catch(() => undefined);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setCheckedIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      setSelected(undefined);
    } catch (cause) { setError(friendlyError(cause)); }
  };

  const toggleSelectionMode = () => {
    setSelected(undefined);
    setShowUploadPanel(false);
    setSelectionMode((current) => {
      if (current) setCheckedIds(new Set());
      return !current;
    });
  };

  const saveGalleryMetadata = async (next: GalleryMetadata) => {
    setGalleryMetadata(next);
    await localStore.saveGalleryMetadata(channel.id, next);
  };

  const toggleFavorite = (item: CloudItem) => {
    const favoriteIds = galleryMetadata.favoriteIds.includes(item.id)
      ? galleryMetadata.favoriteIds.filter((id) => id !== item.id)
      : [...galleryMetadata.favoriteIds, item.id];
    void saveGalleryMetadata({ ...galleryMetadata, favoriteIds });
  };

  const tryLocalFaceDetection = async () => {
    if (faceBusy) return;
    const target = Array.from(checkedIds).map((id) => items.find((item) => item.id === id)).find((item) => item?.kind === "image");
    if (!target) { setFaceMessage("Select at least one image in the gallery first."); return; }
    const Detector = (window as Window & { FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => { detect(source: ImageBitmap): Promise<unknown[]> } }).FaceDetector;
    if (!Detector) { setFaceMessage("This browser does not support the experimental local face-detection API. iPhone Safari usually does not expose it."); return; }
    setFaceBusy(true);
    setFaceMessage("Loading a local thumbnail for face detection…");
    let bitmap: ImageBitmap | undefined;
    try {
      const blob = await telegramDrive.getThumbnail(channel, target);
      if (!blob) throw new Error("No thumbnail is available for this image.");
      bitmap = await createImageBitmap(blob);
      const faces = await new Detector({ fastMode: true, maxDetectedFaces: 20 }).detect(bitmap);
      setFaceMessage(`Local experiment: detected ${faces.length} face region(s) in “${target.name}”. No face data was uploaded or saved.`);
    } catch (cause) {
      setFaceMessage(`Face-detection test failed: ${friendlyError(cause)}`);
    } finally {
      bitmap?.close();
      setFaceBusy(false);
    }
  };

  const verifySelectedCopies = async (ids: number[]) => {
    if (verificationBusy || !ids.length) return;
    if (ids.length > 10 && !window.confirm(`This will download up to 10 files from Telegram to check their reported sizes. Continue with the first 10 selected files?`)) return;
    const targets = ids.slice(0, 10).map((id) => items.find((item) => item.id === id)).filter((item): item is CloudItem => Boolean(item));
    setVerificationBusy(true);
    setVerificationMessage("Checking file sizes by downloading copies from Telegram…");
    let passed = 0;
    const verifiedIds = new Set(galleryMetadata.verifiedIds);
    try {
      for (const item of targets) {
        try {
          const blob = await telegramDrive.download(channel, item);
          if (item.size > 0 && blob.size === item.size) { verifiedIds.add(item.id); passed += 1; }
          else verifiedIds.delete(item.id);
        } catch {
          verifiedIds.delete(item.id);
        }
      }
      await saveGalleryMetadata({ ...galleryMetadata, verifiedIds: Array.from(verifiedIds) });
      setVerificationMessage(`Size check complete: ${passed} of ${targets.length} files downloaded with the expected size. This does not compare against the original iPhone file.`);
    } finally {
      setVerificationBusy(false);
    }
  };

  const createAlbum = (title: string, itemIds: number[]) => {
    const album: SavedAlbum = { id: `album-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, itemIds: Array.from(new Set(itemIds)), createdAt: Date.now() };
    void saveGalleryMetadata({ ...galleryMetadata, albums: [album, ...galleryMetadata.albums] });
  };

  const openAlbum = (album: SavedAlbum) => {
    setActiveAlbumId(album.id);
    setFavoritesOnly(false);
    setFilter("all");
    setShowInsights(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const toggleChecked = (item: CloudItem) => {
    setCheckedIds((current) => {
      const next = new Set(current);
      next.has(item.id) ? next.delete(item.id) : next.add(item.id);
      return next;
    });
  };

  const checkedItems = items.filter((item) => checkedIds.has(item.id));
  const allVisibleChecked = visibleItems.length > 0 && visibleItems.every((item) => checkedIds.has(item.id));
  const toggleAllVisible = () => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (allVisibleChecked) visibleItems.forEach((item) => next.delete(item.id));
      else visibleItems.forEach((item) => next.add(item.id));
      return next;
    });
  };

  const selectEntireGallery = async () => {
    if (bulkBusy) return;
    setBulkBusy(true);
    setLoadingMore(true);
    setError("");
    try {
      const requestedKey = `${channel.id}:${sortOrder}`;
      const allItems = [...items];
      let nextOffset = offsetRef.current;
      let more = hasMore;
      let pagesRead = 0;
      while (more && pagesRead < 10000) {
        const previousOffset = nextOffset;
        const page = await telegramDrive.getHistory(channel, nextOffset, 100, sortOrder === "oldest");
        if (activeHistoryKeyRef.current !== requestedKey) return;
        for (const item of page.items) {
          if (!allItems.some((existing) => existing.id === item.id)) allItems.push(item);
        }
        nextOffset = page.nextOffset;
        more = page.hasMore && nextOffset !== previousOffset;
        pagesRead += 1;
      }
      if (more) throw new Error("Stopped because Telegram did not advance to the next page. Please try again.");
      setItems(allItems);
      offsetRef.current = nextOffset;
      setHasMore(false);
      setCheckedIds(new Set(allItems.map((item) => item.id)));
    } catch (cause) {
      setError(`Could not select the entire gallery: ${friendlyError(cause)}`);
    } finally {
      setBulkBusy(false);
      setLoadingMore(false);
    }
  };

  const downloadSelected = async () => {
    const targets = [...checkedItems];
    if (!targets.length || bulkBusy) return;
    const directoryPicker = (window as SaveFilePickerWindow).showDirectoryPicker;
    let directory: NativeDirectoryHandle | undefined;
    if (directoryPicker) {
      try {
        directory = await directoryPicker.call(window);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(friendlyError(cause));
        return;
      }
    } else if (targets.length > 1 && !window.confirm(`Download ${targets.length} selected files? Your browser may ask you to allow multiple downloads.`)) {
      return;
    }

    setBulkBusy(true);
    bulkCancelRequested.current = false;
    setError("");
    try {
      const usedNames = new Set<string>();
      for (const item of targets) {
        if (bulkCancelRequested.current) break;
        if (!directory) {
          await downloadItem(item);
          continue;
        }
        const controller = new AbortController();
        downloadAbort.current = controller;
        setDownloadEntry({ name: item.name, progress: 0 });
        const handle = await directory.getFileHandle(uniqueDownloadName(item.name, usedNames), { create: true });
        const writable = await handle.createWritable();
        try {
          await telegramDrive.downloadTo(channel, item, (chunk) => writable.write(chunk), (progress) => setDownloadEntry({ name: item.name, progress }), controller.signal);
          await writable.close();
        } catch (cause) {
          try { await writable.abort(cause); } catch { /* The stream may already be closed. */ }
          throw cause;
        } finally {
          if (downloadAbort.current === controller) downloadAbort.current = undefined;
        }
      }
    } catch (cause) {
      if (!bulkCancelRequested.current) setError(friendlyError(cause));
    } finally {
      downloadAbort.current = undefined;
      setDownloadEntry(undefined);
      setBulkBusy(false);
    }
  };

  const deleteSelected = async () => {
    const targets = [...checkedItems];
    if (!targets.length || bulkBusy) return;
    if (!window.confirm(`Permanently delete ${targets.length} selected ${targets.length === 1 ? "file" : "files"} from Telegram? This cannot be undone.`)) return;
    setBulkBusy(true);
    setError("");
    try {
      await telegramDrive.deleteMany(channel, targets);
      await forgetDeletedUploadRecords(targets.map((item) => item.name)).catch(() => undefined);
      const deletedIds = new Set(targets.map((item) => item.id));
      setItems((current) => current.filter((item) => !deletedIds.has(item.id)));
      setCheckedIds(new Set());
      setSelectionMode(false);
    } catch (cause) {
      setError(friendlyError(cause));
      // Telegram may have accepted an earlier 100-item chunk. Reload the
      // channel so the gallery reflects the authoritative history.
      offsetRef.current = 0;
      await load(true);
    } finally {
      setBulkBusy(false);
    }
  };

  const tabs: Array<{ value: Filter; label: string; icon: typeof GridIcon }> = [
    { value: "all", label: "All files", icon: GridIcon },
    { value: "image", label: "Photos", icon: ImageIcon },
    { value: "video", label: "Videos", icon: VideoIcon },
    { value: "audio", label: "Audio", icon: MusicIcon },
    { value: "file", label: "Documents", icon: FileIcon },
  ];
  const selectedIndex = selected ? visibleItems.findIndex((item) => item.id === selected.id) : -1;
  const previousItem = selectedIndex > 0 ? visibleItems[selectedIndex - 1] : undefined;
  const nextItem = selectedIndex >= 0 && selectedIndex < visibleItems.length - 1 ? visibleItems[selectedIndex + 1] : undefined;
  const queueHasWork = uploadSnapshot.pending > 0;
  const directoryPickerSupported = typeof (window as SaveFilePickerWindow).showDirectoryPicker === "function" || "webkitdirectory" in document.createElement("input");

  return (
    <div className="app-shell" onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}>
      <aside className="sidebar">
        <Brand onClick={onHome} />
        <ChannelSwitcher channel={channel} channels={channels} showPublic={showPublicChannels} onShowPublic={onShowPublicChannels} onSelect={onSelectChannel} onCreate={onCreateChannel} onRename={onRenameChannel} onDelete={deleteStorageChannel} onManage={onChangeChannel} />
        <nav>{tabs.map(({ value, label, icon: TabIcon }) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}><TabIcon />{label}<span>{value === "all" ? `${items.length}${hasMore ? "+" : ""}` : items.filter((item) => item.kind === value).length}</span></button>)}</nav>
        <div className="sidebar-foot"><button onClick={() => setSettings(true)}><SettingsIcon />Settings</button><div className="account-chip"><span>{userName(account).slice(0, 1).toUpperCase()}</span><div><strong>{userName(account)}</strong><small><i className={online ? "online" : ""} />{online ? "Connected" : "Offline"}</small></div></div></div>
      </aside>
      <main className="drive-main">
        <header className="mobile-drive-nav">
          <div className="mobile-app-bar"><button className="mobile-wordmark" onClick={onHome} aria-label="Go to home page"><CloudIcon />Unlimited Cloud Storage</button><div className="mobile-app-actions"><button className="primary-button mobile-upload" onClick={openSync} aria-label={queueHasWork ? "Add more files to the upload queue" : "Sync files now"}><UploadIcon /><span>{queueHasWork ? "Add files" : "Sync now"}</span></button><button className="mobile-settings" onClick={() => setSettings(true)} aria-label="Open settings"><SettingsIcon /></button></div></div>
          <div className="mobile-title-row"><div className="mobile-title-copy"><h1>{tabs.find((tab) => tab.value === filter)?.label}</h1><p>{visibleItems.length}{hasMore ? "+" : ""} {visibleItems.length === 1 ? "item" : "items"}</p></div><div className="mobile-channel-control"><ChannelSwitcher channel={channel} channels={channels} showPublic={showPublicChannels} onShowPublic={onShowPublicChannels} onSelect={onSelectChannel} onCreate={onCreateChannel} onRename={onRenameChannel} onDelete={deleteStorageChannel} onManage={onChangeChannel} /></div></div>
          <label className="search-box mobile-search"><SearchIcon /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files" aria-label="Search files" />{search && <button onClick={() => setSearch("")} aria-label="Clear search"><CloseIcon /></button>}</label>
          <div className="mobile-tools"><button className={groupByMonth ? "active" : ""} onClick={() => setGroupByMonth((value) => !value)} aria-pressed={groupByMonth}><CalendarIcon />{groupByMonth ? "Grouped" : "By month"}</button><button onClick={() => { setSortOrder((value) => value === "newest" ? "oldest" : "newest"); window.scrollTo({ top: 0, behavior: "smooth" }); }}><RefreshIcon />{sortOrder === "newest" ? "Newest" : "Oldest"}</button><button className={favoritesOnly ? "active" : ""} onClick={() => { setFavoritesOnly((value) => !value); setActiveAlbumId(undefined); }} aria-pressed={favoritesOnly}>★ Favorites</button><button onClick={() => setShowInsights(true)}>Insights</button><button className={selectionMode ? "active" : ""} onClick={toggleSelectionMode} aria-pressed={selectionMode}><CheckIcon />{selectionMode ? "Cancel" : "Select"}</button></div>
        </header>
        <header className="drive-header desktop-drive-header">
          <div><h1>{tabs.find((tab) => tab.value === filter)?.label}</h1><p>{channel.title} <span>·</span> {visibleItems.length} {visibleItems.length === 1 ? "item" : "items"}</p></div>
          <div className="header-actions"><button className={`secondary-button month-toggle ${groupByMonth ? "active" : ""}`} onClick={() => setGroupByMonth((value) => !value)} aria-pressed={groupByMonth} aria-label="Group files by month" title="Group files by month"><CalendarIcon /><span>{groupByMonth ? "Grouped" : "Group by month"}</span></button><button className="secondary-button sort-toggle" aria-label={`Order: ${sortOrder === "newest" ? "newest first" : "oldest first"}`} title={sortOrder === "newest" ? "Newest first" : "Oldest first"} onClick={() => { setSortOrder((value) => value === "newest" ? "oldest" : "newest"); window.scrollTo({ top: 0, behavior: "smooth" }); }}><RefreshIcon /><span>{sortOrder === "newest" ? "Newest first" : "Oldest first"}</span></button><button className={`secondary-button ${favoritesOnly ? "active" : ""}`} onClick={() => { setFavoritesOnly((value) => !value); setActiveAlbumId(undefined); }} aria-pressed={favoritesOnly}>★ Favorites</button><button className="secondary-button" onClick={() => setShowInsights(true)}>Insights</button><button className={`secondary-button select-toggle ${selectionMode ? "active" : ""}`} onClick={toggleSelectionMode} aria-pressed={selectionMode}><CheckIcon /><span>{selectionMode ? "Cancel" : "Select"}</span></button><label className="search-box"><SearchIcon /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files" aria-label="Search files" />{search && <button onClick={() => setSearch("")} aria-label="Clear search"><CloseIcon /></button>}</label><button className="primary-button" onClick={openSync} aria-label={queueHasWork ? "Add more files to the upload queue" : "Sync files now"}><UploadIcon />{queueHasWork ? "Add files" : "Sync now"}</button></div>
        </header>
        <div className="mobile-tabs">{tabs.map(({ value, label }) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div>
        <input ref={mediaInput} type="file" accept="image/*,video/*" multiple hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) void handleFiles(event.target.files); event.target.value = ""; }} />
        <input ref={fileInput} type="file" multiple hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) void handleFiles(event.target.files); event.target.value = ""; }} />
        <input ref={directoryInput} type="file" multiple hidden {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) void handleFiles(event.target.files); event.target.value = ""; }} />
        {error && <div className="error-banner drive-error" role="alert"><span>{error}</span><button onClick={() => setError("")}><CloseIcon /></button></div>}
        {loading ? <GallerySkeleton /> : visibleItems.length ? (
          <MemoryGallery items={visibleItems} channel={channel} groupByMonth={groupByMonth} sortOrder={sortOrder} memoryLimitMb={effectiveMemoryMb} hasMore={hasMore} paused={Boolean(selected)} selectionMode={selectionMode} selectedIds={checkedIds} favoriteIds={new Set(galleryMetadata.favoriteIds)} onToggleFavorite={toggleFavorite} onOpen={setSelected} onToggleSelection={toggleChecked} onDownload={downloadItem} onDelete={deleteItem} />
        ) : <EmptyState hasItems={items.length > 0} onUpload={openSync} />}
        <div ref={sentinel} className="scroll-sentinel">{loadingMore && <><span className="spinner" />{search.trim() ? "Searching older files…" : "Loading older files…"}</>}{!hasMore && items.length > 0 && <span>You've reached the beginning.</span>}</div>
      </main>
      {dragging && <div className="drop-overlay" onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}><div><UploadIcon /><h2>Drop to upload</h2><p>Files go directly to {channel.title}</p></div></div>}
      {showSyncChooser && <SyncChooser supportsDirectory={directoryPickerSupported} pendingCount={uploadSnapshot.pending} totalCount={uploadSnapshot.total} onPhotos={() => mediaInput.current?.click()} onFiles={() => fileInput.current?.click()} onDirectory={() => void selectDirectory()} onClose={() => setShowSyncChooser(false)} />}
      {showUploadPanel && (uploadSnapshot.total > 0 || uploadSnapshot.skipped > 0 || uploadSnapshot.duplicatesSkipped > 0) && <UploadPanel snapshot={uploadSnapshot} onPause={pauseUploads} onResume={() => void resumeUploads()} onSelectMore={() => setShowSyncChooser(true)} onDiscardUnfinished={() => void dismissUnfinishedUploads()} onDismiss={() => setShowUploadPanel(false)} />}
      {selectionMode && <BulkActionBar count={checkedItems.length} allVisibleSelected={allVisibleChecked} busy={bulkBusy} onToggleAll={toggleAllVisible} onSelectEntireGallery={() => void selectEntireGallery()} onDownload={() => void downloadSelected()} onDelete={() => void deleteSelected()} onCancel={() => { setSelectionMode(false); setCheckedIds(new Set()); }} />}
      {downloadEntry && <DownloadPanel entry={downloadEntry} onCancel={() => { bulkCancelRequested.current = bulkBusy; downloadAbort.current?.abort(); }} />}
      {selected && <Viewer key={selected.id} channel={channel} item={selected} previewLimitBytes={previewLimitBytes} onClose={() => setSelected(undefined)} onPrevious={previousItem ? () => setSelected(previousItem) : undefined} onNext={nextItem ? () => setSelected(nextItem) : undefined} onDownload={() => void downloadItem(selected)} onDelete={() => void deleteItem(selected)} />}
      {showInsights && <InsightsPanel items={items} favoriteIds={galleryMetadata.favoriteIds} verifiedIds={galleryMetadata.verifiedIds} albums={galleryMetadata.albums} selectedIds={Array.from(checkedIds)} verificationBusy={verificationBusy} verificationMessage={verificationMessage} faceBusy={faceBusy} faceMessage={faceMessage} onTryFaceDetection={() => void tryLocalFaceDetection()} onVerifySelected={() => void verifySelectedCopies(Array.from(checkedIds))} onClose={() => setShowInsights(false)} onToggleFavorite={toggleFavorite} onCreateAlbum={createAlbum} onOpenItem={(item) => { setSelected(item); setShowInsights(false); }} onOpenAlbum={openAlbum} />}
      {settings && <SettingsPanel account={account} theme={theme} memoryLimitMb={memoryLimitMb} effectiveMemoryMb={effectiveMemoryMb} preventDuplicateNames={preventDuplicateNames} datePrefixUploads={datePrefixUploads} onTheme={onTheme} onMemoryLimit={async (value) => { setMemoryLimitMb(value); await localStore.saveMemoryLimitMb(value); }} onPreventDuplicateNames={async (value) => { setPreventDuplicateNames(value); await localStore.savePreventDuplicateNames(value); }} onDatePrefixUploads={async (value) => { setDatePrefixUploads(value); await localStore.saveDatePrefixUploads(value); }} onClose={() => setSettings(false)} onForget={onForget} onLogOut={onLogOut} />}
    </div>
  );
}

function ChannelSwitcher({ channel, channels, showPublic, onShowPublic, onSelect, onCreate, onRename, onDelete, onManage }: {
  channel: CloudChannel;
  channels: CloudChannel[];
  showPublic: boolean;
  onShowPublic: (value: boolean) => void;
  onSelect: (channel: CloudChannel) => Promise<void>;
  onCreate: (title: string) => Promise<CloudChannel>;
  onRename: (channel: CloudChannel, title: string) => Promise<CloudChannel>;
  onDelete: (channel: CloudChannel) => Promise<void>;
  onManage: () => void;
}) {
  const availableChannels = channels.filter((entry) => showPublic || !entry.isPublic || entry.id === channel.id);
  const details = useRef<HTMLDetailsElement>(null);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createTitle, setCreateTitle] = useState("Unlimited Cloud Storage");
  const [createError, setCreateError] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [editTitle, setEditTitle] = useState("");
  const [channelBusy, setChannelBusy] = useState<string>();
  const [channelError, setChannelError] = useState("");
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (details.current && !details.current.contains(event.target as Node)) details.current.removeAttribute("open");
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);
  const select = (next: CloudChannel) => {
    details.current?.removeAttribute("open");
    if (next.id !== channel.id) void onSelect(next);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const title = createTitle.trim();
    if (!title) return setCreateError("Enter a channel name.");
    if (title.length > 128) return setCreateError("Keep the name under 128 characters.");
    setCreateBusy(true);
    setCreateError("");
    try {
      const created = await onCreate(title);
      details.current?.removeAttribute("open");
      await onSelect(created);
    } catch (cause) {
      setCreateError(friendlyError(cause));
      setCreateBusy(false);
    }
  };
  const saveRename = async (event: FormEvent, target: CloudChannel) => {
    event.preventDefault();
    const title = editTitle.trim();
    if (!title) return setChannelError("Enter a channel name.");
    if (title.length > 128) return setChannelError("Keep the name under 128 characters.");
    if (title === target.title) { setEditingId(undefined); return; }
    setChannelBusy(target.id);
    setChannelError("");
    try {
      await onRename(target, title);
      setEditingId(undefined);
    } catch (cause) {
      setChannelError(friendlyError(cause));
    } finally {
      setChannelBusy(undefined);
    }
  };
  const remove = async (target: CloudChannel) => {
    if (!window.confirm(`Permanently delete “${target.title}” and every file in it from Telegram? This cannot be undone.`)) return;
    setChannelBusy(target.id);
    setChannelError("");
    try {
      await onDelete(target);
    } catch (cause) {
      setChannelError(friendlyError(cause));
      setChannelBusy(undefined);
    }
  };
  return <div className="channel-switcher"><span>Storage channel</span><details className="channel-select" ref={details}><summary aria-label="Switch storage channel"><FolderIcon /><strong title={channel.title}>{channel.title}</strong><ChevronIcon /></summary><div className="channel-dropdown">{availableChannels.map((entry) => editingId === entry.id ? <form key={entry.id} className="dropdown-channel-edit" onSubmit={(event) => void saveRename(event, entry)}><input autoFocus maxLength={128} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} disabled={channelBusy === entry.id} aria-label={`New name for ${entry.title}`} /><button type="button" onClick={() => { setEditingId(undefined); setChannelError(""); }} disabled={channelBusy === entry.id}>Cancel</button><button type="submit" disabled={channelBusy === entry.id}>Save</button></form> : <div className={`dropdown-channel-row ${entry.id === channel.id ? "selected" : ""}`} key={entry.id}><button className="dropdown-channel-choice" onClick={() => select(entry)} disabled={!entry.canWrite || Boolean(channelBusy)}><span><strong>{entry.title}</strong><small>{entry.isPublic ? "Public" : "Private"}{entry.canWrite ? "" : " · Read-only"}</small></span>{entry.id === channel.id && <CheckIcon />}</button>{(entry.canRename || entry.canDelete) && <div className="dropdown-channel-actions">{entry.canRename && <button onClick={() => { setEditingId(entry.id); setEditTitle(entry.title); setChannelError(""); }} disabled={Boolean(channelBusy)} aria-label={`Rename ${entry.title}`} title="Rename channel"><EditIcon /></button>}{entry.canDelete && <button className="danger" onClick={() => void remove(entry)} disabled={Boolean(channelBusy)} aria-label={`Delete ${entry.title}`} title="Delete channel">{channelBusy === entry.id ? <span className="spinner" /> : <TrashIcon />}</button>}</div>}</div>)}{channelError && <small className="dropdown-channel-error" role="alert">{channelError}</small>}<div className="dropdown-create">{creating ? <form className="dropdown-create-form" onSubmit={create}><label>Channel name<input autoFocus maxLength={128} value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} disabled={createBusy} /></label>{createError && <small role="alert">{createError}</small>}<div><button type="button" onClick={() => { setCreating(false); setCreateError(""); }} disabled={createBusy}>Cancel</button><button type="submit" disabled={createBusy}>{createBusy ? <><span className="spinner" />Creating…</> : "Create"}</button></div></form> : <button className="dropdown-create-button" onClick={() => { setCreating(true); setCreateError(""); }}><PlusIcon /><span><strong>Create new channel</strong><small>Private storage channel</small></span></button>}</div><label className="dropdown-public-toggle"><span><strong>Show public</strong><small>May be visible to subscribers</small></span><input type="checkbox" checked={showPublic} onChange={(event) => onShowPublic(event.target.checked)} /></label></div></details><button className="channel-manage" onClick={onManage}>Manage channels</button></div>;
}

function MemoryGallery({ items, channel, groupByMonth, sortOrder, memoryLimitMb, hasMore, paused, selectionMode, selectedIds, favoriteIds, onToggleFavorite, onOpen, onToggleSelection, onDownload, onDelete }: {
  items: CloudItem[];
  channel: CloudChannel;
  groupByMonth: boolean;
  sortOrder: SortOrder;
  memoryLimitMb: number;
  hasMore: boolean;
  paused: boolean;
  selectionMode: boolean;
  selectedIds: Set<number>;
  favoriteIds: Set<number>;
  onToggleFavorite: (item: CloudItem) => void;
  onOpen: (item: CloudItem) => void;
  onToggleSelection: (item: CloudItem) => void;
  onDownload: (item: CloudItem) => Promise<void>;
  onDelete: (item: CloudItem) => Promise<void>;
}) {
  const [layout, setLayout] = useState(() => ({ columns: estimateColumns(), rowHeight: estimateRowHeight() }));
  useEffect(() => {
    const resize = () => setLayout({ columns: estimateColumns(), rowHeight: estimateRowHeight() });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const targetChunkSize = Math.max(40, Math.min(120, Math.floor(memoryLimitMb / 8)));
  const rowsPerChunk = Math.max(6, Math.floor(targetChunkSize / layout.columns));
  const chunkSize = rowsPerChunk * layout.columns;
  const prefetchPx = Math.max(500, Math.min(2400, memoryLimitMb * 2));
  const groups = useMemo(() => {
    if (!groupByMonth) return [{ key: "all", label: "", items }];
    const grouped = new Map<string, { label: string; items: CloudItem[] }>();
    for (const item of items) {
      const groupingDate = dateFromFileName(item.name) || item.date;
      const key = monthKey(groupingDate);
      const current = grouped.get(key) || { label: formatMonth(groupingDate), items: [] };
      current.items.push(item);
      grouped.set(key, current);
    }
    return Array.from(grouped, ([key, value]) => ({ key, ...value }))
      .sort((left, right) => sortOrder === "newest"
        ? right.key.localeCompare(left.key)
        : left.key.localeCompare(right.key));
  }, [groupByMonth, items, sortOrder]);
  let chunkIndex = 0;
  return <div className={groupByMonth ? "month-groups" : "gallery-groups"} aria-live="polite">{groups.map((group, groupIndex) => {
    const chunkCount = Math.ceil(group.items.length / chunkSize);
    return <section className="month-group" key={group.key}>{group.label && <h2><span>{group.label}</span><small>{group.items.length} {group.items.length === 1 ? "file" : "files"}</small></h2>}<div className="gallery-chunks">{Array.from({ length: chunkCount }, (_, index) => {
      const chunk = group.items.slice(index * chunkSize, (index + 1) * chunkSize);
      const currentIndex = chunkIndex++;
      const isLastChunk = groupIndex === groups.length - 1 && index === chunkCount - 1;
      const placeholderCount = hasMore && isLastChunk ? (layout.columns - chunk.length % layout.columns) % layout.columns : 0;
      const estimatedHeight = Math.ceil((chunk.length + placeholderCount) / layout.columns) * layout.rowHeight;
      return <VirtualGalleryChunk key={`${group.key}:${index}`} items={chunk} channel={channel} paused={paused} selectionMode={selectionMode} selectedIds={selectedIds} favoriteIds={favoriteIds} onToggleFavorite={onToggleFavorite} placeholderCount={placeholderCount} initiallyActive={currentIndex < 2} estimatedHeight={estimatedHeight} prefetchPx={prefetchPx} onOpen={onOpen} onToggleSelection={onToggleSelection} onDownload={onDownload} onDelete={onDelete} />;
    })}</div></section>;
  })}</div>;
}

const estimateColumns = () => {
  const width = window.innerWidth;
  if (width <= 580) return 2;
  const contentWidth = width <= 900 ? width - 40 : width - 230 - Math.max(50, width * .08);
  return Math.max(1, Math.floor((contentWidth + 20) / 210));
};
const estimateRowHeight = () => window.innerWidth <= 580 ? 190 : 230;

function VirtualGalleryChunk({ items, channel, paused, selectionMode, selectedIds, favoriteIds, onToggleFavorite, placeholderCount, initiallyActive, estimatedHeight, prefetchPx, onOpen, onToggleSelection, onDownload, onDelete }: {
  items: CloudItem[];
  channel: CloudChannel;
  paused: boolean;
  selectionMode: boolean;
  selectedIds: Set<number>;
  favoriteIds: Set<number>;
  onToggleFavorite: (item: CloudItem) => void;
  placeholderCount: number;
  initiallyActive: boolean;
  estimatedHeight: number;
  prefetchPx: number;
  onOpen: (item: CloudItem) => void;
  onToggleSelection: (item: CloudItem) => void;
  onDownload: (item: CloudItem) => Promise<void>;
  onDelete: (item: CloudItem) => Promise<void>;
}) {
  const [active, setActive] = useState(initiallyActive);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setMeasuredHeight(0), [estimatedHeight, items.length]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting && element.childElementCount) setMeasuredHeight(element.getBoundingClientRect().height);
      setActive(entry.isIntersecting);
    }, { rootMargin: `${prefetchPx}px 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  }, [prefetchPx]);
  return <div ref={ref} className={`gallery virtual-chunk ${active ? "active" : "parked"}`} style={active ? undefined : { minHeight: `${measuredHeight || estimatedHeight}px` }}>{active && <>{items.map((item) => <MediaCard key={item.id} channel={channel} item={item} pauseThumbnail={paused} selectionMode={selectionMode} selected={selectedIds.has(item.id)} favorite={favoriteIds.has(item.id)} onToggleFavorite={() => onToggleFavorite(item)} onOpen={() => onOpen(item)} onToggleSelection={() => onToggleSelection(item)} onDownload={() => void onDownload(item)} onDelete={() => void onDelete(item)} />)}{Array.from({ length: placeholderCount }, (_, index) => <div className="memory-slot" aria-hidden="true" key={`slot:${index}`}><span /><i /><i /></div>)}</>}</div>;
}

function Thumbnail({ channel, item, paused }: { channel: CloudChannel; item: CloudItem; paused: boolean }) {
  const [url, setUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (paused) { setUrl(""); setLoaded(false); return; }
    let active = true;
    let objectUrl = "";
    const controller = new AbortController();
    telegramDrive.getThumbnail(channel, item, controller.signal, retry > 0).then((blob) => {
      if (active && blob) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
      if (active) setLoaded(true);
    }).catch(() => { if (active) setLoaded(true); });
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [channel, item.id, paused, retry]);
  const Placeholder = item.kind === "video" ? VideoIcon : item.kind === "audio" ? MusicIcon : item.kind === "image" ? ImageIcon : FileIcon;
  const failed = () => { setUrl(""); if (retry < 1) { setLoaded(false); setRetry(1); } else setLoaded(true); };
  return <div className={`thumbnail ${loaded ? "loaded" : ""}`}>{url ? <img src={url} alt="" loading="lazy" onError={failed} /> : <Placeholder />}{item.kind === "video" && <span className="play-badge">▶</span>}</div>;
}

function MediaCard({ channel, item, pauseThumbnail, selectionMode, selected, favorite, onToggleFavorite, onOpen, onToggleSelection, onDownload, onDelete }: { channel: CloudChannel; item: CloudItem; pauseThumbnail: boolean; selectionMode: boolean; selected: boolean; favorite: boolean; onToggleFavorite: () => void; onOpen: () => void; onToggleSelection: () => void; onDownload: () => void; onDelete: () => void }) {
  const [menu, setMenu] = useState(false);
  return <article className={`media-card ${item.kind === "file" || item.kind === "audio" ? "document-card" : ""} ${selected ? "selection-selected" : ""}`}>
    <button className="media-open" onClick={selectionMode ? onToggleSelection : onOpen} aria-pressed={selectionMode ? selected : undefined}><Thumbnail channel={channel} item={item} paused={pauseThumbnail} /><span className="media-info"><strong title={item.name}>{item.name}</strong><small>{formatDate(item.date)} · {formatSize(item.size)}</small></span></button>
    {selectionMode && <span className={`selection-check ${selected ? "checked" : ""}`} aria-hidden="true">{selected && <CheckIcon />}</span>}
    {!selectionMode && <button className="card-menu" aria-label={`Actions for ${item.name}`} onClick={() => setMenu((value) => !value)}><MoreIcon /></button>}
    {!selectionMode && menu && <div className="action-menu" onMouseLeave={() => setMenu(false)}><button onClick={() => { setMenu(false); onToggleFavorite(); }}>{favorite ? "★ Remove favorite" : "☆ Add to favorites"}</button><button onClick={() => { setMenu(false); onDownload(); }}><DownloadIcon />Download</button><button className="danger" onClick={() => { setMenu(false); onDelete(); }}><TrashIcon />Delete</button></div>}
  </article>;
}

function GallerySkeleton() {
  return <section className="gallery skeleton-gallery">{Array.from({ length: 12 }, (_, index) => <div key={index} className="skeleton-card"><span /><i /><i /></div>)}</section>;
}

function EmptyState({ hasItems, onUpload }: { hasItems: boolean; onUpload: () => void }) {
  return <div className="empty-state">{hasItems ? <SearchIcon /> : <CloudIcon />}<h2>{hasItems ? "No matches found" : "Your cloud is ready"}</h2><p>{hasItems ? "Try a different search or file type." : "Sync your first files. They will appear here and in your private Telegram channel."}</p>{!hasItems && <button className="primary-button" onClick={onUpload}><UploadIcon />Sync now</button>}</div>;
}

function SyncChooser({ supportsDirectory, pendingCount, totalCount, onPhotos, onFiles, onDirectory, onClose }: {
  supportsDirectory: boolean;
  pendingCount: number;
  totalCount: number;
  onPhotos: () => void;
  onFiles: () => void;
  onDirectory: () => void;
  onClose: () => void;
}) {
  const appending = pendingCount > 0;
  return <div className="modal-backdrop sync-backdrop" role="dialog" aria-modal="true" aria-label={appending ? "Add files to upload queue" : "Sync files now"} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="sync-chooser"><header><div><span className="eyebrow">{appending ? "Queue more while syncing" : "Foreground sync"}</span><h2>{appending ? "Add to queue" : "Sync now"}</h2></div><button onClick={onClose} aria-label="Close"><CloseIcon /></button></header>{appending && <div className="queue-live-count"><span className="spinner" /><strong>{pendingCount.toLocaleString()} waiting</strong><small>{totalCount.toLocaleString()} in this sync</small></div>}<p>Select another batch whenever the iPhone picker starts to lag. Each selection is appended behind the files already waiting, so you can build a queue of hundreds or thousands over multiple picker rounds.</p><div className="sync-options"><button className="primary-button" onClick={onPhotos}><ImageIcon />Choose photos &amp; videos</button><button className="secondary-button" onClick={onFiles}><FileIcon />Choose files</button>{supportsDirectory && <button className="secondary-button" onClick={onDirectory}><FolderIcon />Choose a folder</button>}</div><div className="security-box"><ShieldIcon /><p><strong>No giant local buffer</strong>Files upload one at a time from bounded slices. Queue metadata is saved locally, but original file bytes are not copied into IndexedDB.</p></div><small className="sync-note">Keep this app open until the queue finishes. iOS may suspend or discard the page in the background; inaccessible entries after a reload can be dismissed without affecting Telegram files.</small></section></div>;
}

function UploadPanel({ snapshot, onPause, onResume, onSelectMore, onDiscardUnfinished, onDismiss }: {
  snapshot: UploadSnapshot;
  onPause: () => void;
  onResume: () => void;
  onSelectMore: () => void;
  onDiscardUnfinished: () => void;
  onDismiss: () => void;
}) {
  const onlyUnfinished = snapshot.needsFile > 0 && snapshot.pending === 0;
  const title = snapshot.paused ? "Sync paused" : onlyUnfinished ? "Unfinished sync" : snapshot.pending > 0 ? "Syncing files" : snapshot.failed > 0 ? "Sync needs attention" : "Sync complete";
  const processed = snapshot.done + snapshot.failed;
  const runProcessed = Math.max(0, processed - snapshot.runStartedProcessed);
  const estimatedRemaining = !snapshot.paused && snapshot.pending > 0 && snapshot.runStartedAt && runProcessed > 0
    ? (Date.now() - snapshot.runStartedAt) / runProcessed * snapshot.pending
    : undefined;
  const rateLimitRemaining = snapshot.rateLimitUntil ? Math.max(0, snapshot.rateLimitUntil - Date.now()) : 0;
  const rateLimitDuration = snapshot.rateLimitStartedAt && snapshot.rateLimitUntil ? snapshot.rateLimitUntil - snapshot.rateLimitStartedAt : 0;
  const rateLimitProgress = rateLimitDuration ? Math.min(1, Math.max(0, 1 - rateLimitRemaining / rateLimitDuration)) : 0;
  return <aside className="upload-panel" aria-live="polite"><div className="panel-title"><div><strong>{rateLimitRemaining ? "Waiting for Telegram" : title}</strong><small>{snapshot.total.toLocaleString()} queued · {snapshot.done.toLocaleString()} uploaded{snapshot.skipped ? ` · ${snapshot.skipped.toLocaleString()} already synced` : ""}{snapshot.duplicatesSkipped ? ` · ${snapshot.duplicatesSkipped.toLocaleString()} duplicate names skipped` : ""}</small></div><button onClick={onlyUnfinished ? onDiscardUnfinished : onDismiss} aria-label={onlyUnfinished ? "Dismiss unfinished sync" : "Hide sync status"}><CloseIcon /></button></div><div className="upload-summary"><div><span>{snapshot.currentName || (snapshot.needsFile ? `${snapshot.needsFile.toLocaleString()} inaccessible local ${snapshot.needsFile === 1 ? "file" : "files"}` : "Queue ready")}</span><strong>{snapshot.currentName ? `${Math.round(snapshot.currentProgress * 100)}%` : `${processed.toLocaleString()}/${snapshot.total.toLocaleString()}`}</strong></div>{snapshot.currentName && <progress className="progress current-upload-progress" max={1} value={snapshot.currentProgress} />}<progress className="progress" max={Math.max(1, snapshot.total)} value={Math.min(snapshot.total, processed)} />{snapshot.currentName && <small>Current file · attempt {snapshot.currentAttempt} of {MAX_UPLOAD_ATTEMPTS}</small>}<small>Overall queue · {processed.toLocaleString()} of {snapshot.total.toLocaleString()} processed{estimatedRemaining ? ` · ${formatRemainingTime(estimatedRemaining)}` : snapshot.pending > 0 && !snapshot.paused ? " · estimating after the first file" : ""}</small></div>{rateLimitRemaining > 0 && <div className="rate-limit-wait"><div><span><i />Telegram asked this app to slow down</span><strong>{formatCountdown(rateLimitRemaining)}</strong></div><progress max={1} value={rateLimitProgress} /><small>The current file will resume automatically. This wait does not use a retry attempt.</small></div>}<div className="upload-counts"><span><strong>{snapshot.pending.toLocaleString()}</strong> waiting</span><span><strong>{snapshot.done.toLocaleString()}</strong> done</span><span><strong>{snapshot.failed.toLocaleString()}</strong> failed</span></div>{snapshot.recent.map((entry) => <div className="upload-row" key={entry.id}><FileIcon /><div><span><strong title={entry.name}>{entry.name}</strong><small>{entry.status === "retrying" ? "retrying" : entry.status}</small></span>{entry.error && <em>{entry.error}</em>}</div></div>)}<div className="upload-actions"><button className="primary-button" onClick={onSelectMore}><PlusIcon />Add files</button>{snapshot.pending > 0 && !snapshot.paused && <button className="secondary-button" onClick={onPause}>Pause</button>}{(snapshot.paused || snapshot.failed > 0) && <button className="secondary-button" onClick={onResume}>{snapshot.failed > 0 ? "Retry failed" : "Resume"}</button>}{snapshot.needsFile > 0 && <button className="secondary-button" onClick={onDiscardUnfinished}>Dismiss unfinished</button>}</div><p className="upload-foreground-note">{onlyUnfinished ? "Dismiss removes only the unfinished local queue entries. It never deletes files from Telegram." : `Add more picker batches at any time. Uploads retry up to ${MAX_UPLOAD_ATTEMPTS} times and continue with the next file after a permanent failure. Keep the app in the foreground.`}</p></aside>;
}

function BulkActionBar({ count, allVisibleSelected, busy, onToggleAll, onSelectEntireGallery, onDownload, onDelete, onCancel }: {
  count: number;
  allVisibleSelected: boolean;
  busy: boolean;
  onToggleAll: () => void;
  onSelectEntireGallery: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  return <aside className="bulk-action-bar" aria-label="Selected file actions"><strong>{count.toLocaleString()} selected</strong><button className="bulk-select-all" onClick={onToggleAll} disabled={busy}>{allVisibleSelected ? "Clear visible" : "Select visible"}</button><button className="bulk-select-all" onClick={onSelectEntireGallery} disabled={busy}>Select entire gallery</button><span /><button onClick={onDownload} disabled={!count || busy}><DownloadIcon />Download</button><button className="danger" onClick={onDelete} disabled={!count || busy}><TrashIcon />Delete</button><button className="bulk-close" onClick={onCancel} disabled={busy} aria-label="Exit selection mode"><CloseIcon /></button></aside>;
}

function DownloadPanel({ entry, onCancel }: { entry: DownloadEntry; onCancel: () => void }) {
  return <aside className="download-panel" aria-live="polite"><DownloadIcon /><div><strong title={entry.name}>{entry.name}</strong><small>Downloading… {Math.round(entry.progress * 100)}%</small><progress className="progress" max={1} value={entry.progress} /></div><button onClick={onCancel} aria-label="Cancel download"><CloseIcon /></button></aside>;
}

function Viewer({ channel, item, previewLimitBytes, onClose, onPrevious, onNext, onDownload, onDelete }: { channel: CloudChannel; item: CloudItem; previewLimitBytes: number; onClose: () => void; onPrevious?: () => void; onNext?: () => void; onDownload: () => void; onDelete: () => void }) {
  const [url, setUrl] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [progressiveFailed, setProgressiveFailed] = useState(false);
  const [streamPlaybackFailed, setStreamPlaybackFailed] = useState(false);
  const [posterUrl, setPosterUrl] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [heicDecoding, setHeicDecoding] = useState(false);
  const [heicFallbackTried, setHeicFallbackTried] = useState(false);
  const imageBlob = useRef<Blob | undefined>(undefined);
  const heicPreviewUrl = useRef("");
  const streamEverOpened = useRef(false);
  const progressiveCandidate = item.kind === "video" || item.kind === "audio";
  useEffect(() => {
    if (item.kind !== "image" && item.kind !== "video") return;
    let active = true;
    let objectUrl = "";
    void telegramDrive.getCachedThumbnail(item).then((blob) => {
      if (active && blob?.size) { objectUrl = URL.createObjectURL(blob); setPosterUrl(objectUrl); }
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item]);
  useEffect(() => {
    if (!progressiveCandidate || progressiveFailed || streamPlaybackFailed) return;
    let active = true;
    let close: () => void = () => {};
    void telegramDrive.openProgressiveStream(channel, item).then((stream) => {
      close = stream.close;
      if (active) {
        streamEverOpened.current = true;
        setStreamUrl(stream.url);
      }
      else stream.close();
    }).catch(() => {
      if (!active) return;
      if (streamEverOpened.current) {
        setStreamPlaybackFailed(true);
        setError("Progressive playback could not restart. Download the original file or close and try again.");
      } else {
        setProgressiveFailed(true);
      }
    });
    return () => { active = false; close(); };
  }, [channel, item, progressiveCandidate, progressiveFailed, streamPlaybackFailed]);
  useEffect(() => {
    if (item.kind !== "image" && item.kind !== "video" && item.kind !== "audio") return;
    if (progressiveCandidate && !progressiveFailed) return;
    if (item.size > previewLimitBytes) return;
    const controller = new AbortController();
    let objectUrl = "";
    telegramDrive.download(channel, item, setProgress, controller.signal).then((blob) => {
      if (blob && !controller.signal.aborted) { imageBlob.current = item.kind === "image" ? blob : undefined; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }).catch((cause) => { if (!controller.signal.aborted) setError(friendlyError(cause)); });
    return () => { controller.abort(); imageBlob.current = undefined; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [channel, item, previewLimitBytes, progressiveCandidate, progressiveFailed]);
  useEffect(() => () => { if (heicPreviewUrl.current) URL.revokeObjectURL(heicPreviewUrl.current); }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft" && onPrevious) { event.preventDefault(); onPrevious(); }
      else if (event.key === "ArrowRight" && onNext) { event.preventDefault(); onNext(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, onNext, onPrevious]);
  const previewFailed = () => {
    if (item.kind === "image" && isHeicItem(item) && imageBlob.current && !heicFallbackTried) {
      const originalUrl = url;
      setHeicFallbackTried(true);
      setHeicDecoding(true);
      setUrl("");
      void decodeHeicPreview(imageBlob.current).then((jpeg) => {
        if (originalUrl) URL.revokeObjectURL(originalUrl);
        heicPreviewUrl.current = URL.createObjectURL(jpeg);
        setUrl(heicPreviewUrl.current);
      }).catch((cause) => {
        setError(`This HEIC image could not be decoded locally: ${friendlyError(cause)}`);
      }).finally(() => setHeicDecoding(false));
      return;
    }
    if (streamUrl && !progressiveFailed) {
      setStreamUrl("");
      setStreamPlaybackFailed(true);
      setError("Progressive playback was interrupted. Retry the stream or download the original file.");
      return;
    }
    setError("This browser cannot decode this media format. The original file is still available to download.");
  };
  const retryStream = () => {
    setError("");
    setProgress(0);
    setStreamPlaybackFailed(false);
  };
  const mediaUrl = streamUrl || url;
  return <div className="modal-backdrop viewer-backdrop" role="dialog" aria-modal="true" aria-label={item.name} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="viewer"><header><div><strong>{item.name}</strong><small>{formatSize(item.size)} · {formatDate(item.date)}</small></div><div><button onClick={onDownload} title="Download"><DownloadIcon /></button><button className="danger" onClick={onDelete} title="Delete"><TrashIcon /></button><button onClick={onClose} title="Close"><CloseIcon /></button></div></header><div className="viewer-content"><button className="viewer-nav previous" onClick={onPrevious} disabled={!onPrevious} aria-label="Previous file"><ChevronIcon /></button>{error ? <div className="viewer-message"><FileIcon /><p>{error}</p><div className="viewer-message-actions">{streamPlaybackFailed && <button className="secondary-button" onClick={retryStream}><RefreshIcon />Retry stream</button>}<button className="primary-button" onClick={onDownload}><DownloadIcon />Download original</button></div></div> : mediaUrl && (item.kind === "video" || item.kind === "audio") ? <ProgressivePlayer kind={item.kind} src={mediaUrl} poster={posterUrl} streaming={Boolean(streamUrl)} onError={previewFailed} /> : mediaUrl && item.kind === "image" ? <div className="viewer-image-frame"><img src={mediaUrl} alt={item.name} onError={previewFailed} /></div> : <div className="viewer-message">{(!progressiveCandidate || progressiveFailed) && item.size > previewLimitBytes ? <><VideoIcon /><p>This file exceeds the current preview memory limit. Download it to view, or raise the limit in Settings.</p><button className="primary-button" onClick={onDownload}><DownloadIcon />Download</button></> : item.kind === "file" ? <><FileIcon /><p>Preview is not available for this file type.</p><button className="primary-button" onClick={onDownload}><DownloadIcon />Download</button></> : posterUrl ? <div className="viewer-loading-preview"><img src={posterUrl} alt="" onError={() => setPosterUrl("")} /><span><i className="spinner" />{progressiveCandidate && !progressiveFailed ? "Preparing stream…" : heicDecoding ? "Decoding HEIC on this device…" : <>Loading original… {progress ? `${Math.round(progress * 100)}%` : ""}</>}</span></div> : <><span className="spinner large" /><p>{progressiveCandidate && !progressiveFailed ? "Preparing progressive playback…" : heicDecoding ? "Decoding HEIC on this device…" : <>Loading preview… {progress ? `${Math.round(progress * 100)}%` : ""}</>}</p></>}</div>}<button className="viewer-nav next" onClick={onNext} disabled={!onNext} aria-label="Next file"><ChevronIcon /></button></div></div></div>;
}

function ProgressivePlayer({ kind, src, poster, streaming, onError }: { kind: "video" | "audio"; src: string; poster: string; streaming: boolean; onError: () => void }) {
  const [buffered, setBuffered] = useState(0);
  const [duration, setDuration] = useState(0);
  const updateBuffer = (media: HTMLMediaElement) => {
    const nextDuration = Number.isFinite(media.duration) ? media.duration : 0;
    setDuration(nextDuration);
    if (!media.buffered.length) return setBuffered(0);
    let end = media.buffered.end(media.buffered.length - 1);
    for (let index = 0; index < media.buffered.length; index += 1) {
      if (media.currentTime >= media.buffered.start(index) && media.currentTime <= media.buffered.end(index)) {
        end = media.buffered.end(index);
        break;
      }
    }
    setBuffered(end);
  };
  const trackBuffer = (event: SyntheticEvent<HTMLMediaElement>) => updateBuffer(event.currentTarget);
  const common = { src, controls: true, autoPlay: true, preload: "metadata" as const, onError, onProgress: trackBuffer, onDurationChange: trackBuffer, onTimeUpdate: trackBuffer };
  return <div className={`progressive-player ${kind}`}>{kind === "video" ? <video {...common} poster={poster || undefined} playsInline /> : <audio {...common} />}{streaming && <div className="stream-buffer" aria-label="Streaming buffer"><span>Buffered</span><progress max={duration || 1} value={Math.min(buffered, duration || buffered)} /><small>{duration > 0 ? `${Math.round(buffered)}s` : "Connecting…"}</small></div>}</div>;
}

function SettingsPanel({ account, theme, memoryLimitMb, effectiveMemoryMb, preventDuplicateNames, datePrefixUploads, onTheme, onMemoryLimit, onPreventDuplicateNames, onDatePrefixUploads, onClose, onForget, onLogOut }: {
  account: any;
  theme: Theme;
  memoryLimitMb: number;
  effectiveMemoryMb: number;
  preventDuplicateNames: boolean;
  datePrefixUploads: boolean;
  onTheme: (theme: Theme) => Promise<void>;
  onMemoryLimit: (value: number) => Promise<void>;
  onPreventDuplicateNames: (value: boolean) => Promise<void>;
  onDatePrefixUploads: (value: boolean) => Promise<void>;
  onClose: () => void;
  onForget: () => Promise<void>;
  onLogOut: () => Promise<void>;
}) {
  const [cleared, setCleared] = useState(false);
  const clearCache = async () => { await localStore.clearThumbnails(); setCleared(true); };
  return <div className="modal-backdrop settings-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="settings-panel">
      <header><div><span className="eyebrow">Preferences</span><h2>Settings</h2></div><button onClick={onClose}><CloseIcon /></button></header>
      <section><h3>Account</h3><div className="settings-row"><span className="avatar">{userName(account).slice(0, 1).toUpperCase()}</span><div><strong>{userName(account)}</strong><small>Telegram account</small></div></div></section>
      <section><h3>Appearance</h3><label className="settings-toggle"><span><strong>Dark mode</strong><small>Use the darker interface on this browser.</small></span><input type="checkbox" checked={theme === "dark"} onChange={(event) => void onTheme(event.target.checked ? "dark" : "light")} /></label></section>
      <section><h3>Uploads</h3><label className="settings-toggle"><span><strong>Prevent duplicate filenames</strong><small>Skip a file when the same name is already discovered in this channel or its local sync queue. Unloaded older history may not be checked.</small></span><input type="checkbox" checked={preventDuplicateNames} onChange={(event) => void onPreventDuplicateNames(event.target.checked)} /></label><label className="settings-toggle"><span><strong>Prefix names with media date</strong><small>Use embedded capture date first, then a date in the filename, and finally the file's last-modified date.</small></span><input type="checkbox" checked={datePrefixUploads} onChange={(event) => void onDatePrefixUploads(event.target.checked)} /></label></section>
      <section><h3>Performance</h3><label className="memory-setting"><span><strong>Memory limit</strong><small>Controls off-screen gallery preloading and full-file preview fallback.</small></span><select value={memoryLimitMb} onChange={(event) => void onMemoryLimit(Number(event.target.value))}><option value={256}>256 MB</option><option value={512}>512 MB</option><option value={1024}>1 GB (default)</option><option value={2048}>2 GB</option></select><em>{effectiveMemoryMb < memoryLimitMb ? `Adjusted to ${formatSize(effectiveMemoryMb * 1024 * 1024)} for this device.` : "The browser may use less when content is off screen."}</em></label></section>
      <section><h3>Privacy & device</h3><div className="security-box"><ShieldIcon /><p><strong>Browser-only connection</strong>Credentials and session data stay in IndexedDB on this browser profile. Files are not end-to-end encrypted by this app.</p></div><button className="settings-action" onClick={clearCache}><RefreshIcon /><span><strong>{cleared ? "Thumbnail cache cleared" : "Clear thumbnail cache"}</strong><small>Original files remain in Telegram</small></span>{cleared && <CheckIcon />}</button><button className="settings-action" onClick={() => void onForget()}><CloseIcon /><span><strong>Forget this browser</strong><small>Remove local credentials, session, and cache only</small></span></button></section>
      <section className="danger-zone"><button onClick={() => void onLogOut()}><TrashIcon />Log out of Telegram</button><small>This revokes this app's Telegram session and clears local data.</small></section>
      <footer>Unlimited Cloud Storage is independent and is not affiliated with Telegram.</footer>
    </aside>
  </div>;
}
