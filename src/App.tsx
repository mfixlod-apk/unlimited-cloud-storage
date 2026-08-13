import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type SyntheticEvent } from "react";
import QRCode from "qrcode";
import {
  CalendarIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CloudIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
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
} from "./icons";
import { localStore } from "./storage";
import {
  telegramDrive,
  type CloudChannel,
  type CloudItem,
  type ItemKind,
  type TelegramCredentials,
} from "./telegram";

type Stage = "boot" | "credentials" | "auth" | "channels" | "drive";
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

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<NativeFileHandle>;
};

const friendlyError = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.toUpperCase();
  if (code.includes("API_ID_INVALID")) return "That API ID and API hash do not match. Check them and try again.";
  if (code.includes("PHONE_NUMBER_INVALID")) return "Enter a valid phone number including the country code.";
  if (code.includes("PHONE_CODE_INVALID")) return "That login code is not correct. Try again.";
  if (code.includes("PHONE_CODE_EXPIRED")) return "That login code expired. Start the phone login again.";
  if (code.includes("PASSWORD_HASH_INVALID")) return "That two-step verification password is not correct.";
  if (code.includes("CHANNELS_TOO_MUCH")) return "This Telegram account has reached its channel limit.";
  if (code.includes("CHAT_TITLE_EMPTY")) return "Enter a name for the storage channel.";
  if (code.includes("FLOOD_WAIT")) return "Telegram asked this device to slow down. Wait a little, then try again.";
  if (code.includes("NETWORK") || code.includes("WEBSOCKET") || code.includes("CONNECTION")) return "Could not reach Telegram. Check your connection or network restrictions.";
  if (code.includes("ABORT")) return "The operation was cancelled.";
  return raw.length < 180 ? raw : "Something went wrong while talking to Telegram. Please try again.";
};

const formatSize = (bytes: number) => {
  if (!bytes) return "Unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index > 1 && value < 10 ? 1 : 0)} ${units[index]}`;
};

const formatDate = (date: Date) => new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
}).format(date);

const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
const formatMonth = (date: Date) => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);

const DIRECT_SAVE_THRESHOLD = 750 * 1024 * 1024;
const previewLimitMb = (effectiveMemoryMb: number) => {
  if (effectiveMemoryMb <= 256) return 128;
  if (effectiveMemoryMb <= 512) return 384;
  if (effectiveMemoryMb <= 1024) return 768;
  return Math.min(1536, Math.floor(effectiveMemoryMb * .75));
};

const userName = (user: any) => [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || "Telegram user";

export default function App() {
  const [stage, setStage] = useState<Stage>("boot");
  const [credentials, setCredentials] = useState<TelegramCredentials>();
  const [remember, setRemember] = useState(false);
  const [account, setAccount] = useState<any>();
  const [channels, setChannels] = useState<CloudChannel[]>([]);
  const [channel, setChannel] = useState<CloudChannel>();
  const [showPublicChannels, setShowPublicChannels] = useState(false);
  const [error, setError] = useState("");

  const prepareAccount = useCallback(async () => {
    const [me, availableChannels, savedChannelId] = await Promise.all([
      telegramDrive.getMe(),
      telegramDrive.listPrivateChannels(),
      localStore.getChannelId(),
    ]);
    setAccount(me);
    setChannels(availableChannels);
    const restoredChannel = availableChannels.find((entry) => entry.id === savedChannelId);
    if (restoredChannel) {
      setChannel(restoredChannel);
      setStage("drive");
    } else {
      setStage("channels");
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const saved = await localStore.getConnection();
        if (!saved) {
          if (active) setStage("credentials");
          return;
        }
        const restored = { apiId: saved.apiId, apiHash: saved.apiHash };
        if (active) setCredentials(restored);
        const authorized = await telegramDrive.connect(restored, saved.session);
        if (!active) return;
        if (authorized) await prepareAccount();
        else setStage("auth");
      } catch (cause) {
        await telegramDrive.disconnect();
        if (active) {
          setError(`We couldn't restore this device: ${friendlyError(cause)}`);
          setStage("credentials");
        }
      }
    })();
    return () => { active = false; };
  }, [prepareAccount]);

  const handleCredentials = async (next: TelegramCredentials, keepSignedIn: boolean) => {
    setError("");
    setCredentials(next);
    setRemember(keepSignedIn);
    setStage("boot");
    try {
      const authorized = await telegramDrive.connect(next);
      if (authorized) await prepareAccount();
      else setStage("auth");
    } catch (cause) {
      setError(friendlyError(cause));
      setStage("credentials");
    }
  };

  const handleAuthenticated = async () => {
    if (!credentials) return;
    if (remember) {
      await localStore.saveConnection({ ...credentials, session: telegramDrive.sessionString() });
    } else {
      await localStore.clearConnection();
    }
    await prepareAccount();
  };

  const chooseChannel = async (next: CloudChannel) => {
    if (!next.canWrite) return;
    if (next.isPublic && !window.confirm(`“${next.title}” is public. Files uploaded there may be visible to every subscriber. Use this channel anyway?`)) return;
    setChannel(next);
    await localStore.saveChannelId(next.id);
    setStage("drive");
  };

  const createChannel = async (title: string) => {
    const created = await telegramDrive.createPrivateChannel(title);
    setChannels((current) => [created, ...current.filter((entry) => entry.id !== created.id)]);
    return created;
  };

  const refreshChannelList = async () => {
    setChannels(await telegramDrive.listPrivateChannels());
  };

  const forgetDevice = async () => {
    await telegramDrive.disconnect();
    await localStore.clearAll();
    setCredentials(undefined);
    setAccount(undefined);
    setChannels([]);
    setChannel(undefined);
    setStage("credentials");
  };

  const logOut = async () => {
    try { await telegramDrive.logOut(); } catch { await telegramDrive.disconnect(); }
    await localStore.clearAll();
    setCredentials(undefined);
    setAccount(undefined);
    setChannel(undefined);
    setStage("credentials");
  };

  if (stage === "boot") return <LoadingScreen />;
  if (stage === "credentials") return <CredentialsScreen initial={credentials} externalError={error} onContinue={handleCredentials} />;
  if (stage === "auth") return <AuthScreen onComplete={handleAuthenticated} onBack={() => { telegramDrive.disconnect(); setStage("credentials"); }} />;
  if (stage === "channels") return <ChannelScreen account={account} channels={channels} showPublic={showPublicChannels} onShowPublic={setShowPublicChannels} onChoose={chooseChannel} onCreate={createChannel} onRefresh={refreshChannelList} onBack={logOut} />;
  if (!channel) return null;
  return (
    <DriveScreen
      key={channel.id}
      account={account}
      channel={channel}
      channels={channels}
      showPublicChannels={showPublicChannels}
      onShowPublicChannels={setShowPublicChannels}
      onSelectChannel={chooseChannel}
      onChangeChannel={() => setStage("channels")}
      onForget={forgetDevice}
      onLogOut={logOut}
    />
  );
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><CloudIcon /></span><span>Unlimited Cloud<br />Storage</span></div>;
}

function LoadingScreen() {
  return <main className="center-screen"><Brand /><div className="loading-line"><span /></div><p className="muted">Opening your private cloud…</p></main>;
}

function CredentialsScreen({ initial, externalError, onContinue }: {
  initial?: TelegramCredentials;
  externalError: string;
  onContinue: (credentials: TelegramCredentials, remember: boolean) => Promise<void>;
}) {
  const [apiId, setApiId] = useState(initial?.apiId ? String(initial.apiId) : "");
  const [apiHash, setApiHash] = useState(initial?.apiHash || "");
  const [showHash, setShowHash] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const id = Number(apiId.trim());
    const hash = apiHash.trim();
    if (!Number.isInteger(id) || id <= 0) return setError("Enter the numeric API ID from Telegram.");
    if (!/^[a-fA-F0-9]{32}$/.test(hash)) return setError("The API hash should contain 32 letters and numbers.");
    setBusy(true);
    setError("");
    await onContinue({ apiId: id, apiHash: hash }, remember);
    setBusy(false);
  };

  return (
    <main className="onboarding-shell">
      <section className="onboarding-copy">
        <Brand />
        <div className="intro-copy">
          <span className="eyebrow">Your files. Your account.</span>
          <h1>A quiet place for everything.</h1>
          <p>Turn a private Telegram channel into a clean personal drive. Your files travel directly between this browser and Telegram—there is no middleman server.</p>
        </div>
        <div className="privacy-note"><ShieldIcon /><span><strong>Local by design</strong>Your credentials and session are handled in this browser and are not sent to an app server, logs, URLs, or analytics.</span></div>
      </section>
      <section className="onboarding-panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="step-label">Step 1 of 3</div>
          <h2>Connect Telegram</h2>
          <p className="muted">Use your own Telegram API credentials. This app has no shared or hidden keys.</p>
          {(error || externalError) && <div className="error-banner" role="alert">{error || externalError}</div>}
          <label className="field-label">API ID<input inputMode="numeric" autoComplete="off" value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="12345678" /></label>
          <label className="field-label">API hash<span className="password-field"><input type={showHash ? "text" : "password"} autoComplete="off" spellCheck={false} value={apiHash} onChange={(e) => setApiHash(e.target.value)} placeholder="32-character API hash" /><button type="button" className="icon-button" onClick={() => setShowHash((value) => !value)} aria-label={showHash ? "Hide API hash" : "Show API hash"}>{showHash ? <EyeOffIcon /> : <EyeIcon />}</button></span></label>
          <label className="check-row"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span><strong>Keep me signed in on this device</strong><small>Stores credentials and the Telegram session in this browser's IndexedDB.</small></span></label>
          <button className="primary-button wide" disabled={busy}>{busy ? <><span className="spinner" />Connecting…</> : <>Continue <ChevronIcon /></>}</button>
          <a className="helper-link" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer noopener">Where do I find these credentials?</a>
          <p className="fine-print">Use only on a device and browser profile you trust. Telegram storage is private-channel storage, not zero-knowledge encryption.</p>
        </form>
      </section>
    </main>
  );
}

type PendingPrompt = { kind: "code" | "password"; hint?: string; viaApp?: boolean; resolve: (value: string) => void };

function AuthScreen({ onComplete, onBack }: { onComplete: () => Promise<void>; onBack: () => void }) {
  const [mode, setMode] = useState<"qr" | "phone">("qr");
  const [qr, setQr] = useState("");
  const [expires, setExpires] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [phone, setPhone] = useState("");
  const [input, setInput] = useState("");
  const [prompt, setPrompt] = useState<PendingPrompt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);

  const askPassword = useCallback((hint?: string) => new Promise<string>((resolve) => {
    setInput("");
    setPrompt({ kind: "password", hint, resolve });
  }), []);

  useEffect(() => {
    if (mode !== "qr") return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    telegramDrive.loginWithQr({
      signal: controller.signal,
      askPassword,
      onQr: async (uri, nextExpiry) => {
        const dataUrl = await QRCode.toDataURL(uri, { width: 280, margin: 2, errorCorrectionLevel: "M", color: { dark: "#20201e", light: "#ffffff" } });
        if (!controller.signal.aborted) {
          setQr(dataUrl);
          setExpires(nextExpiry * 1000);
          setBusy(false);
        }
      },
    }).then(onComplete).catch((cause) => {
      if (!controller.signal.aborted) {
        setError(friendlyError(cause));
        setBusy(false);
      }
    });
    return () => controller.abort();
  }, [askPassword, mode, onComplete]);

  useEffect(() => {
    if (!expires) return;
    const tick = () => setSeconds(Math.max(0, Math.ceil((expires - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expires]);

  const switchMode = (next: "qr" | "phone") => {
    if (next === mode) return;
    abortRef.current?.abort();
    setMode(next);
    setQr("");
    setPrompt(undefined);
    setError("");
  };

  const startPhone = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\+[1-9]\d{6,14}$/.test(phone.replace(/\s/g, ""))) {
      setError("Use the international format, for example +41 79 123 45 67.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await telegramDrive.loginWithPhone({
        phone: phone.replace(/\s/g, ""),
        askCode: (viaApp) => new Promise<string>((resolve) => {
          setInput("");
          setPrompt({ kind: "code", viaApp, resolve });
          setBusy(false);
        }),
        askPassword,
      });
      await onComplete();
    } catch (cause) {
      setError(friendlyError(cause));
      setBusy(false);
      setPrompt(undefined);
    }
  };

  const submitPrompt = (event: FormEvent) => {
    event.preventDefault();
    if (!input.trim()) return;
    const current = prompt;
    setPrompt(undefined);
    setBusy(true);
    current?.resolve(input.trim());
  };

  return (
    <main className="simple-shell">
      <div className="top-brand"><Brand /><button className="text-button" onClick={onBack}>Change credentials</button></div>
      <section className="auth-card auth-card-centered">
        <div className="step-label">Step 2 of 3</div>
        <h2>Sign in to Telegram</h2>
        <div className="segmented"><button className={mode === "qr" ? "active" : ""} onClick={() => switchMode("qr")}>QR code</button><button className={mode === "phone" ? "active" : ""} onClick={() => switchMode("phone")}>Phone number</button></div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {prompt?.kind === "password" ? (
          <form onSubmit={submitPrompt} className="prompt-form">
            <div className="round-icon"><ShieldIcon /></div>
            <h3>Two-step verification</h3>
            <p className="muted">Enter your Telegram password{prompt.hint ? ` (hint: ${prompt.hint})` : ""}. It is sent directly to Telegram and is never stored.</p>
            <input autoFocus type="password" autoComplete="current-password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Telegram password" />
            <button className="primary-button wide">Continue</button>
          </form>
        ) : mode === "qr" ? (
          <div className="qr-flow">
            <div className="qr-frame">{qr ? <img src={qr} alt="Telegram login QR code" /> : <span className="spinner large" />}</div>
            <ol><li>Open Telegram on your phone</li><li>Go to <strong>Settings → Devices</strong></li><li>Tap <strong>Link Desktop Device</strong> and scan</li></ol>
            <p className="qr-expiry">{seconds > 0 ? `Code refreshes in ${seconds}s` : "Refreshing secure code…"}</p>
          </div>
        ) : prompt?.kind === "code" ? (
          <form onSubmit={submitPrompt} className="prompt-form">
            <div className="round-icon"><CheckIcon /></div>
            <h3>Enter the login code</h3>
            <p className="muted">We sent it to {prompt.viaApp ? "your Telegram app" : "your phone"}. Never share it with anyone.</p>
            <input autoFocus inputMode="numeric" autoComplete="one-time-code" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Login code" />
            <button className="primary-button wide">Verify</button>
          </form>
        ) : (
          <form onSubmit={startPhone} className="phone-flow">
            <p className="muted">Use this when you cannot scan a QR code. Your number is used for this login only and is never stored by the app.</p>
            <label className="field-label">Phone number<input type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+41 79 123 45 67" /></label>
            <button className="primary-button wide" disabled={busy}>{busy ? <><span className="spinner" />Requesting code…</> : "Send login code"}</button>
          </form>
        )}
      </section>
    </main>
  );
}

function ChannelScreen({ account, channels, showPublic, onShowPublic, onChoose, onCreate, onRefresh, onBack }: {
  account: any;
  channels: CloudChannel[];
  showPublic: boolean;
  onShowPublic: (value: boolean) => void;
  onChoose: (channel: CloudChannel) => Promise<void>;
  onCreate: (title: string) => Promise<CloudChannel>;
  onRefresh: () => Promise<void>;
  onBack: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("Unlimited Cloud Storage");
  const [error, setError] = useState("");
  const availableChannels = channels.filter((entry) => showPublic || !entry.isPublic);
  const refresh = async () => {
    setBusy(true);
    setError("");
    try { await onRefresh(); } catch (cause) { setError(friendlyError(cause)); }
    finally { setBusy(false); }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return setError("Enter a name for the storage channel.");
    if (cleanTitle.length > 128) return setError("Keep the channel name under 128 characters.");
    setBusy(true);
    setError("");
    try {
      const created = await onCreate(cleanTitle);
      await onChoose(created);
    } catch (cause) {
      setError(friendlyError(cause));
      setBusy(false);
    }
  };
  return (
    <main className="simple-shell">
      <div className="top-brand"><Brand /><button className="text-button" onClick={onBack}>Sign out</button></div>
      <section className="channel-card">
        <div className="step-label">Step 3 of 3</div>
        <h2>Choose your storage</h2>
        <p className="muted">Signed in as <strong>{userName(account)}</strong>. Private broadcast channels are shown by default. Group chats are excluded.</p>
        <label className="public-channel-toggle"><span><strong>Show public channels</strong><small>Public uploads may be visible to subscribers</small></span><input type="checkbox" checked={showPublic} onChange={(event) => onShowPublic(event.target.checked)} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {showCreate && <form className="create-channel-form" onSubmit={create}>
          <label className="field-label">Channel name<input autoFocus maxLength={128} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="My private storage" /></label>
          <p>Telegram will create a private broadcast channel and select it as this drive's storage.</p>
          <div><button type="button" className="text-button" onClick={() => setShowCreate(false)} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? <><span className="spinner" />Creating…</> : "Create channel"}</button></div>
        </form>}
        <div className="channel-list">
          {availableChannels.map((entry) => <button key={entry.id} className="channel-option" onClick={() => onChoose(entry)} disabled={!entry.canWrite} title={entry.canWrite ? undefined : "You need permission to post in this channel"}><span className="round-icon small"><FolderIcon /></span><span><strong>{entry.title}</strong><small>{entry.isPublic ? "Public" : "Private"} channel · {entry.canWrite ? "Ready to use" : "Read-only"}</small></span><ChevronIcon /></button>)}
          {!availableChannels.length && <div className="empty-channels"><FolderIcon /><h3>No channels found</h3><p>Create a private broadcast channel in Telegram, then refresh this list.</p></div>}
        </div>
        <div className="channel-actions"><button className="secondary-button" onClick={() => { setShowCreate(true); setError(""); }} disabled={busy || showCreate}><PlusIcon />Create new channel</button><button className="secondary-button" onClick={refresh} disabled={busy}><RefreshIcon className={busy ? "spinning" : ""} />Refresh</button></div>
      </section>
    </main>
  );
}

interface UploadEntry { id: string; name: string; progress: number; status: "waiting" | "uploading" | "done" | "error" | "cancelled"; error?: string }
interface DownloadEntry { name: string; progress: number }

function DriveScreen({ account, channel, channels, showPublicChannels, onShowPublicChannels, onSelectChannel, onChangeChannel, onForget, onLogOut }: {
  account: any;
  channel: CloudChannel;
  channels: CloudChannel[];
  showPublicChannels: boolean;
  onShowPublicChannels: (value: boolean) => void;
  onSelectChannel: (channel: CloudChannel) => Promise<void>;
  onChangeChannel: () => void;
  onForget: () => Promise<void>;
  onLogOut: () => Promise<void>;
}) {
  const [items, setItems] = useState<CloudItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [groupByMonth, setGroupByMonth] = useState(false);
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [memoryLimitMb, setMemoryLimitMb] = useState(1024);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CloudItem>();
  const [settings, setSettings] = useState(false);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [downloadEntry, setDownloadEntry] = useState<DownloadEntry>();
  const [dragging, setDragging] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | undefined>(undefined);
  const downloadAbort = useRef<AbortController | undefined>(undefined);
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
    setItems([]);
    offsetRef.current = 0;
    setHasMore(true);
    void load(true);
  }, [channel.id, load]);
  useEffect(() => { void localStore.getMemoryLimitMb().then(setMemoryLimitMb); }, []);
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

  // A search scans every remaining history page. Each result kept in React is
  // lightweight metadata; full Teleproto messages are fetched only on demand.
  useEffect(() => {
    if (search.trim() && hasMore && !loading && !loadingMore && !selected) void load(false);
  }, [hasMore, load, loading, loadingMore, search, selected]);

  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return items.filter((item) => (filter === "all" || item.kind === filter) && (!query || item.name.toLocaleLowerCase().includes(query)));
  }, [items, filter, search]);

  const handleFiles = async (list: FileList | File[]) => {
    const files = Array.from(list);
    if (!files.length) return;
    const queued = files.map((file) => ({ id: crypto.randomUUID(), name: file.name, progress: 0, status: "waiting" as const }));
    setUploads((current) => [...current.filter((entry) => entry.status === "uploading"), ...queued]);
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const entry = queued[index];
      const controller = new AbortController();
      uploadAbort.current = controller;
      setUploads((current) => current.map((item) => item.id === entry.id ? { ...item, status: "uploading" } : item));
      try {
        await telegramDrive.upload(channel, file, (progress) => {
          setUploads((current) => current.map((item) => item.id === entry.id ? { ...item, progress } : item));
        }, controller.signal);
        setUploads((current) => current.map((item) => item.id === entry.id ? { ...item, progress: 1, status: "done" } : item));
      } catch (cause) {
        const cancelled = controller.signal.aborted;
        const uploadError = cancelled ? undefined : friendlyError(cause);
        setUploads((current) => current.map((item) => item.id === entry.id ? { ...item, status: cancelled ? "cancelled" : "error", error: uploadError } : item));
        if (uploadError) setError(uploadError);
        if (cancelled) break;
      }
    }
    uploadAbort.current = undefined;
    await load(true);
    window.setTimeout(() => setUploads((current) => current.filter((entry) => entry.status !== "done")), 2500);
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

  const deleteItem = async (item: CloudItem) => {
    if (!window.confirm(`Permanently delete “${item.name}” from Telegram? This cannot be undone.`)) return;
    try {
      await telegramDrive.delete(channel, item);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setSelected(undefined);
    } catch (cause) { setError(friendlyError(cause)); }
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

  return (
    <div className="app-shell" onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}>
      <aside className="sidebar">
        <Brand />
        <ChannelSwitcher channel={channel} channels={channels} showPublic={showPublicChannels} onShowPublic={onShowPublicChannels} onSelect={onSelectChannel} onManage={onChangeChannel} />
        <nav>{tabs.map(({ value, label, icon: TabIcon }) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}><TabIcon />{label}<span>{value === "all" ? `${items.length}${hasMore ? "+" : ""}` : items.filter((item) => item.kind === value).length}</span></button>)}</nav>
        <div className="sidebar-foot"><button onClick={() => setSettings(true)}><SettingsIcon />Settings</button><div className="account-chip"><span>{userName(account).slice(0, 1).toUpperCase()}</span><div><strong>{userName(account)}</strong><small><i className={online ? "online" : ""} />{online ? "Connected" : "Offline"}</small></div></div></div>
      </aside>
      <main className="drive-main">
        <header className="drive-header">
          <div><p className="mobile-brand"><CloudIcon />Unlimited Cloud Storage</p><h1>{tabs.find((tab) => tab.value === filter)?.label}</h1><p>{channel.title} <span>·</span> {visibleItems.length} {visibleItems.length === 1 ? "item" : "items"}</p></div>
          <div className="header-actions"><button className={`secondary-button month-toggle ${groupByMonth ? "active" : ""}`} onClick={() => setGroupByMonth((value) => !value)} aria-pressed={groupByMonth} aria-label="Group files by month" title="Group files by month"><CalendarIcon /><span>{groupByMonth ? "Grouped" : "Group by month"}</span></button><button className="secondary-button sort-toggle" aria-label={`Order: ${sortOrder === "newest" ? "newest first" : "oldest first"}`} title={sortOrder === "newest" ? "Newest first" : "Oldest first"} onClick={() => { setSortOrder((value) => value === "newest" ? "oldest" : "newest"); window.scrollTo({ top: 0, behavior: "smooth" }); }}><RefreshIcon /><span>{sortOrder === "newest" ? "Newest first" : "Oldest first"}</span></button><label className="search-box"><SearchIcon /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files" aria-label="Search files" />{search && <button onClick={() => setSearch("")} aria-label="Clear search"><CloseIcon /></button>}</label><button className="primary-button" onClick={() => fileInput.current?.click()}><UploadIcon />Upload</button><button className="mobile-settings" onClick={() => setSettings(true)} aria-label="Open settings"><SettingsIcon /></button><input ref={fileInput} type="file" multiple hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) void handleFiles(event.target.files); event.target.value = ""; }} /></div>
        </header>
        <div className="mobile-channel-control"><ChannelSwitcher channel={channel} channels={channels} showPublic={showPublicChannels} onShowPublic={onShowPublicChannels} onSelect={onSelectChannel} onManage={onChangeChannel} /></div>
        <div className="mobile-tabs">{tabs.slice(0, 4).map(({ value, label }) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div>
        {error && <div className="error-banner drive-error" role="alert"><span>{error}</span><button onClick={() => setError("")}><CloseIcon /></button></div>}
        {loading ? <GallerySkeleton /> : visibleItems.length ? (
          <MemoryGallery items={visibleItems} channel={channel} groupByMonth={groupByMonth} memoryLimitMb={effectiveMemoryMb} hasMore={hasMore} paused={Boolean(selected)} onOpen={setSelected} onDownload={downloadItem} onDelete={deleteItem} />
        ) : <EmptyState hasItems={items.length > 0} onUpload={() => fileInput.current?.click()} />}
        <div ref={sentinel} className="scroll-sentinel">{loadingMore && <><span className="spinner" />{search.trim() ? "Searching older files…" : "Loading older files…"}</>}{!hasMore && items.length > 0 && <span>You've reached the beginning.</span>}</div>
      </main>
      {dragging && <div className="drop-overlay" onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}><div><UploadIcon /><h2>Drop to upload</h2><p>Files go directly to {channel.title}</p></div></div>}
      {uploads.length > 0 && <UploadPanel entries={uploads} onCancel={() => uploadAbort.current?.abort()} onDismiss={() => setUploads([])} />}
      {downloadEntry && <DownloadPanel entry={downloadEntry} onCancel={() => downloadAbort.current?.abort()} />}
      {selected && <Viewer key={selected.id} channel={channel} item={selected} previewLimitBytes={previewLimitBytes} onClose={() => setSelected(undefined)} onPrevious={previousItem ? () => setSelected(previousItem) : undefined} onNext={nextItem ? () => setSelected(nextItem) : undefined} onDownload={() => void downloadItem(selected)} onDelete={() => void deleteItem(selected)} />}
      {settings && <SettingsPanel account={account} memoryLimitMb={memoryLimitMb} effectiveMemoryMb={effectiveMemoryMb} onMemoryLimit={async (value) => { setMemoryLimitMb(value); await localStore.saveMemoryLimitMb(value); }} onClose={() => setSettings(false)} onForget={onForget} onLogOut={onLogOut} />}
    </div>
  );
}

function ChannelSwitcher({ channel, channels, showPublic, onShowPublic, onSelect, onManage }: {
  channel: CloudChannel;
  channels: CloudChannel[];
  showPublic: boolean;
  onShowPublic: (value: boolean) => void;
  onSelect: (channel: CloudChannel) => Promise<void>;
  onManage: () => void;
}) {
  const availableChannels = channels.filter((entry) => showPublic || !entry.isPublic || entry.id === channel.id);
  const details = useRef<HTMLDetailsElement>(null);
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
  return <div className="channel-switcher"><span>Storage channel</span><details className="channel-select" ref={details}><summary aria-label="Switch storage channel"><FolderIcon /><strong title={channel.title}>{channel.title}</strong><ChevronIcon /></summary><div className="channel-dropdown">{availableChannels.map((entry) => <button key={entry.id} onClick={() => select(entry)} disabled={!entry.canWrite} className={entry.id === channel.id ? "selected" : ""}><span><strong>{entry.title}</strong><small>{entry.isPublic ? "Public" : "Private"}{entry.canWrite ? "" : " · Read-only"}</small></span>{entry.id === channel.id && <CheckIcon />}</button>)}<label className="dropdown-public-toggle"><span><strong>Show public</strong><small>May be visible to subscribers</small></span><input type="checkbox" checked={showPublic} onChange={(event) => onShowPublic(event.target.checked)} /></label></div></details><button className="channel-manage" onClick={onManage}>Manage channels</button></div>;
}

function MemoryGallery({ items, channel, groupByMonth, memoryLimitMb, hasMore, paused, onOpen, onDownload, onDelete }: {
  items: CloudItem[];
  channel: CloudChannel;
  groupByMonth: boolean;
  memoryLimitMb: number;
  hasMore: boolean;
  paused: boolean;
  onOpen: (item: CloudItem) => void;
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
      const key = monthKey(item.date);
      const current = grouped.get(key) || { label: formatMonth(item.date), items: [] };
      current.items.push(item);
      grouped.set(key, current);
    }
    return Array.from(grouped, ([key, value]) => ({ key, ...value }));
  }, [groupByMonth, items]);
  let chunkIndex = 0;
  return <div className={groupByMonth ? "month-groups" : "gallery-groups"} aria-live="polite">{groups.map((group, groupIndex) => {
    const chunkCount = Math.ceil(group.items.length / chunkSize);
    return <section className="month-group" key={group.key}>{group.label && <h2><span>{group.label}</span><small>{group.items.length} {group.items.length === 1 ? "file" : "files"}</small></h2>}<div className="gallery-chunks">{Array.from({ length: chunkCount }, (_, index) => {
      const chunk = group.items.slice(index * chunkSize, (index + 1) * chunkSize);
      const currentIndex = chunkIndex++;
      const isLastChunk = groupIndex === groups.length - 1 && index === chunkCount - 1;
      const placeholderCount = hasMore && isLastChunk ? (layout.columns - chunk.length % layout.columns) % layout.columns : 0;
      const estimatedHeight = Math.ceil((chunk.length + placeholderCount) / layout.columns) * layout.rowHeight;
      return <VirtualGalleryChunk key={`${group.key}:${index}`} items={chunk} channel={channel} paused={paused} placeholderCount={placeholderCount} initiallyActive={currentIndex < 2} estimatedHeight={estimatedHeight} prefetchPx={prefetchPx} onOpen={onOpen} onDownload={onDownload} onDelete={onDelete} />;
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

function VirtualGalleryChunk({ items, channel, paused, placeholderCount, initiallyActive, estimatedHeight, prefetchPx, onOpen, onDownload, onDelete }: {
  items: CloudItem[];
  channel: CloudChannel;
  paused: boolean;
  placeholderCount: number;
  initiallyActive: boolean;
  estimatedHeight: number;
  prefetchPx: number;
  onOpen: (item: CloudItem) => void;
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
  return <div ref={ref} className={`gallery virtual-chunk ${active ? "active" : "parked"}`} style={active ? undefined : { minHeight: `${measuredHeight || estimatedHeight}px` }}>{active && <>{items.map((item) => <MediaCard key={item.id} channel={channel} item={item} pauseThumbnail={paused} onOpen={() => onOpen(item)} onDownload={() => void onDownload(item)} onDelete={() => void onDelete(item)} />)}{Array.from({ length: placeholderCount }, (_, index) => <div className="memory-slot" aria-hidden="true" key={`slot:${index}`}><span /><i /><i /></div>)}</>}</div>;
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

function MediaCard({ channel, item, pauseThumbnail, onOpen, onDownload, onDelete }: { channel: CloudChannel; item: CloudItem; pauseThumbnail: boolean; onOpen: () => void; onDownload: () => void; onDelete: () => void }) {
  const [menu, setMenu] = useState(false);
  return <article className={`media-card ${item.kind === "file" || item.kind === "audio" ? "document-card" : ""}`}>
    <button className="media-open" onClick={onOpen}><Thumbnail channel={channel} item={item} paused={pauseThumbnail} /><span className="media-info"><strong title={item.name}>{item.name}</strong><small>{formatDate(item.date)} · {formatSize(item.size)}</small></span></button>
    <button className="card-menu" aria-label={`Actions for ${item.name}`} onClick={() => setMenu((value) => !value)}><MoreIcon /></button>
    {menu && <div className="action-menu" onMouseLeave={() => setMenu(false)}><button onClick={() => { setMenu(false); onDownload(); }}><DownloadIcon />Download</button><button className="danger" onClick={() => { setMenu(false); onDelete(); }}><TrashIcon />Delete</button></div>}
  </article>;
}

function GallerySkeleton() {
  return <section className="gallery skeleton-gallery">{Array.from({ length: 12 }, (_, index) => <div key={index} className="skeleton-card"><span /><i /><i /></div>)}</section>;
}

function EmptyState({ hasItems, onUpload }: { hasItems: boolean; onUpload: () => void }) {
  return <div className="empty-state">{hasItems ? <SearchIcon /> : <CloudIcon />}<h2>{hasItems ? "No matches found" : "Your cloud is ready"}</h2><p>{hasItems ? "Try a different search or file type." : "Upload your first file. It will appear here and in your private Telegram channel."}</p>{!hasItems && <button className="primary-button" onClick={onUpload}><UploadIcon />Upload files</button>}</div>;
}

function UploadPanel({ entries, onCancel, onDismiss }: { entries: UploadEntry[]; onCancel: () => void; onDismiss: () => void }) {
  const active = entries.some((entry) => entry.status === "uploading" || entry.status === "waiting");
  const failed = entries.some((entry) => entry.status === "error");
  const title = active ? "Uploading files" : failed ? "Upload failed" : "Uploads complete";
  return <aside className="upload-panel"><div className="panel-title"><div><strong>{title}</strong><small>{entries.length} {entries.length === 1 ? "file" : "files"}</small></div><button onClick={active ? onCancel : onDismiss} aria-label={active ? "Cancel uploads" : "Dismiss uploads"}><CloseIcon /></button></div>{entries.map((entry) => <div className="upload-row" key={entry.id}><FileIcon /><div><span><strong>{entry.name}</strong><small>{entry.status === "uploading" ? `${Math.round(entry.progress * 100)}%` : entry.status}</small></span><progress className={`progress ${entry.status}`} max={1} value={entry.progress} />{entry.error && <em>{entry.error}</em>}</div></div>)}</aside>;
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
      if (blob && !controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }).catch((cause) => { if (!controller.signal.aborted) setError(friendlyError(cause)); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [channel, item, previewLimitBytes, progressiveCandidate, progressiveFailed]);
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
  return <div className="modal-backdrop viewer-backdrop" role="dialog" aria-modal="true" aria-label={item.name} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="viewer"><header><div><strong>{item.name}</strong><small>{formatSize(item.size)} · {formatDate(item.date)}</small></div><div><button onClick={onDownload} title="Download"><DownloadIcon /></button><button className="danger" onClick={onDelete} title="Delete"><TrashIcon /></button><button onClick={onClose} title="Close"><CloseIcon /></button></div></header><div className="viewer-content"><button className="viewer-nav previous" onClick={onPrevious} disabled={!onPrevious} aria-label="Previous file"><ChevronIcon /></button>{error ? <div className="viewer-message"><FileIcon /><p>{error}</p><div className="viewer-message-actions">{streamPlaybackFailed && <button className="secondary-button" onClick={retryStream}><RefreshIcon />Retry stream</button>}<button className="primary-button" onClick={onDownload}><DownloadIcon />Download original</button></div></div> : mediaUrl && (item.kind === "video" || item.kind === "audio") ? <ProgressivePlayer kind={item.kind} src={mediaUrl} poster={posterUrl} streaming={Boolean(streamUrl)} onError={previewFailed} /> : mediaUrl && item.kind === "image" ? <img src={mediaUrl} alt={item.name} onError={previewFailed} /> : <div className="viewer-message">{(!progressiveCandidate || progressiveFailed) && item.size > previewLimitBytes ? <><VideoIcon /><p>This file exceeds the current preview memory limit. Download it to view, or raise the limit in Settings.</p><button className="primary-button" onClick={onDownload}><DownloadIcon />Download</button></> : item.kind === "file" ? <><FileIcon /><p>Preview is not available for this file type.</p><button className="primary-button" onClick={onDownload}><DownloadIcon />Download</button></> : posterUrl ? <div className="viewer-loading-preview"><img src={posterUrl} alt="" onError={() => setPosterUrl("")} /><span><i className="spinner" />{progressiveCandidate && !progressiveFailed ? "Preparing stream…" : <>Loading original… {progress ? `${Math.round(progress * 100)}%` : ""}</>}</span></div> : <><span className="spinner large" /><p>{progressiveCandidate && !progressiveFailed ? "Preparing progressive playback…" : <>Loading preview… {progress ? `${Math.round(progress * 100)}%` : ""}</>}</p></>}</div>}<button className="viewer-nav next" onClick={onNext} disabled={!onNext} aria-label="Next file"><ChevronIcon /></button></div></div></div>;
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

function SettingsPanel({ account, memoryLimitMb, effectiveMemoryMb, onMemoryLimit, onClose, onForget, onLogOut }: {
  account: any;
  memoryLimitMb: number;
  effectiveMemoryMb: number;
  onMemoryLimit: (value: number) => Promise<void>;
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
      <section><h3>Performance</h3><label className="memory-setting"><span><strong>Memory limit</strong><small>Controls off-screen gallery preloading and full-file preview fallback.</small></span><select value={memoryLimitMb} onChange={(event) => void onMemoryLimit(Number(event.target.value))}><option value={256}>256 MB</option><option value={512}>512 MB</option><option value={1024}>1 GB (default)</option><option value={2048}>2 GB</option></select><em>{effectiveMemoryMb < memoryLimitMb ? `Adjusted to ${formatSize(effectiveMemoryMb * 1024 * 1024)} for this device.` : "The browser may use less when content is off screen."}</em></label></section>
      <section><h3>Privacy & device</h3><div className="security-box"><ShieldIcon /><p><strong>Browser-only connection</strong>Credentials and session data stay in IndexedDB on this browser profile. Files are not end-to-end encrypted by this app.</p></div><button className="settings-action" onClick={clearCache}><RefreshIcon /><span><strong>{cleared ? "Thumbnail cache cleared" : "Clear thumbnail cache"}</strong><small>Original files remain in Telegram</small></span>{cleared && <CheckIcon />}</button><button className="settings-action" onClick={() => void onForget()}><CloseIcon /><span><strong>Forget this browser</strong><small>Remove local credentials, session, and cache only</small></span></button></section>
      <section className="danger-zone"><button onClick={() => void onLogOut()}><TrashIcon />Log out of Telegram</button><small>This revokes this app's Telegram session and clears local data.</small></section>
      <footer>Unlimited Cloud Storage is independent and is not affiliated with Telegram.</footer>
    </aside>
  </div>;
}
