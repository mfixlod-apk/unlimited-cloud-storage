import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import {
  BrowserIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CloudIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  KeyIcon,
  PlusIcon,
  PhoneIcon,
  RefreshIcon,
  SettingsIcon,
  ShieldIcon,
  TelegramIcon,
} from "../icons";
import { telegramDrive, type CloudChannel, type TelegramCredentials } from "../telegram";
import { Brand } from "./Brand";
import { friendlyError, userName } from "./shared";

export function LoadingScreen() {
  return <main className="center-screen"><Brand /><div className="loading-line"><span /></div><p className="muted">Opening your private cloud…</p></main>;
}

export function LandingScreen({ initial, externalError, account, onContinue, onOpenWorkspace, onLogOut, onSwitchAccount }: {
  initial?: TelegramCredentials;
  externalError: string;
  account?: any;
  onContinue: (credentials: TelegramCredentials, remember: boolean) => Promise<void>;
  onOpenWorkspace?: () => void;
  onLogOut?: () => Promise<void>;
  onSwitchAccount?: () => Promise<void>;
}) {
  const [apiId, setApiId] = useState(initial?.apiId ? String(initial.apiId) : "");
  const [apiHash, setApiHash] = useState(initial?.apiHash || "");
  const [showHash, setShowHash] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loginTarget = useRef<HTMLElement>(null);
  const homeScrollTarget = useRef<HTMLElement>(null);

  const scrollToLogin = () => loginTarget.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  const scrollHome = () => {
    homeScrollTarget.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

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
      <section className="onboarding-copy" ref={homeScrollTarget}>
        <div className="landing-inner">
          <nav className="landing-nav" aria-label="Home"><Brand onClick={scrollHome} /><button className="secondary-button landing-login-button" onClick={account ? onOpenWorkspace : scrollToLogin}>{account ? "Open drive" : "Log in"}</button></nav>
          <div className="intro-copy">
            <h1>A simple, secure place for your backups.</h1>
            <p>Use a private Telegram channel as a clean personal drive. Your files move directly between this browser and Telegram—there is no application server, shared storage account, or upload relay in the middle.</p>
          </div>
          <section className="landing-story landing-connection" aria-labelledby="landing-connection-title">
            <header><span className="eyebrow">One direct connection</span><h2 id="landing-connection-title">Your browser talks to Telegram. That's the whole path.</h2></header>
            <div className="connection-path" aria-label="Browser connects directly to a private Telegram channel"><div><span><BrowserIcon /></span><strong>This browser</strong><small>Your session stays here</small></div><i><ChevronIcon /></i><div><span><TelegramIcon /></span><strong>Telegram</strong><small>Your private channel</small></div></div>
            <p className="story-note">Files are stored as Telegram channel messages, so another signed-in device can rebuild the gallery from channel history.</p>
          </section>
          <section className="landing-story landing-everyday" aria-labelledby="landing-everyday-title">
            <header><span className="eyebrow">Made for everyday use</span><h2 id="landing-everyday-title">A small app that adjusts to the way you use it.</h2></header>
            <div className="everyday-pair">
              <article><span><PhoneIcon /></span><div><strong>Keep it close</strong><p>Add it to your home screen, then use the same clean gallery on phone or desktop.</p></div></article>
              <article><span><SettingsIcon /></span><div><strong>Make it yours</strong><p>Choose the storage channel, memory budget, file naming, ordering, and duplicate rules.</p></div></article>
            </div>
          </section>
          <section className="landing-story landing-control" aria-labelledby="landing-control-title">
            <header><span className="eyebrow">Leave on your terms</span><h2 id="landing-control-title">Stay signed in—or leave no local session behind.</h2></header>
            <div className="control-list"><article><ShieldIcon /><span><strong>No tracking layer</strong><small>No analytics, application logs, or secrets in URLs.</small></span></article><article><KeyIcon /><span><strong>You choose persistence</strong><small>Keeping the Telegram session in this browser is optional.</small></span></article><article><CloseIcon /><span><strong>Forget or revoke</strong><small>Clear only this browser, or explicitly log out of Telegram.</small></span></article></div>
            <div className="privacy-note"><ShieldIcon /><span><strong>Clear security boundary</strong>Telegram can process files stored in its channels. Encrypt sensitive material before upload if you need zero-knowledge storage.</span></div>
          </section>
          <small className="landing-disclaimer">Independent project. Not affiliated with or endorsed by Telegram.</small>
        </div>
      </section>
      <section className="onboarding-panel" id="telegram-login" ref={loginTarget}>
        {account ? <div className="auth-card signed-in-card"><div className="step-label">Telegram connected</div><span className="signed-in-avatar">{userName(account).slice(0, 1).toUpperCase()}</span><h2>You're already signed in.</h2><p className="muted">Connected as <strong>{userName(account)}</strong>. Opening this home page did not disconnect your account.</p><button className="primary-button wide" onClick={onOpenWorkspace}>Open your drive <ChevronIcon /></button><div className="signed-in-actions"><button className="secondary-button" onClick={() => void onSwitchAccount?.()}>Sign in to another account</button><button className="text-button danger-text" onClick={() => void onLogOut?.()}>Log out</button></div><p className="fine-print">Signing in to another account first revokes this app's current Telegram session.</p></div> : <form className="auth-card" onSubmit={submit}>
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
        </form>}
      </section>
    </main>
  );
}

type PendingPrompt = { kind: "code" | "password"; hint?: string; viaApp?: boolean; resolve: (value: string) => void };

export function AuthScreen({ onComplete, onBack }: { onComplete: () => Promise<void>; onBack: () => void }) {
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

export function ChannelScreen({ account, channels, showPublic, onShowPublic, onChoose, onCreate, onRefresh, onHome, onBack }: {
  account: any;
  channels: CloudChannel[];
  showPublic: boolean;
  onShowPublic: (value: boolean) => void;
  onChoose: (channel: CloudChannel) => Promise<void>;
  onCreate: (title: string) => Promise<CloudChannel>;
  onRefresh: () => Promise<void>;
  onHome: () => void;
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
      <div className="top-brand"><Brand onClick={onHome} /><button className="text-button" onClick={onBack}>Sign out</button></div>
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
