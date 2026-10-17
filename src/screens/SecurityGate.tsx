import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { localStore } from "../storage";

const ITERATIONS = 210_000;
const AUTO_LOCK_MS = 2 * 60 * 1000;
type SecurityConfig = { salt: string; hash: string; iterations: number; enabled: boolean };

function bytesToHex(bytes: Uint8Array) { return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(hex: string) { return new Uint8Array(hex.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16)) || []); }
async function derivePin(pin: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt.slice().buffer as ArrayBuffer, iterations, hash: "SHA-256" }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
async function createConfig(pin: string): Promise<SecurityConfig> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: bytesToHex(salt), hash: await derivePin(pin, salt, ITERATIONS), iterations: ITERATIONS, enabled: true };
}

export function SecurityGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SecurityConfig>();
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [setupMode, setSetupMode] = useState(false);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    const openSettings = () => {
      if (!locked && !setupMode) {
        setShowSettings(true);
        setPin("");
        setConfirmPin("");
        setError("");
      }
    };
    window.addEventListener("open-security-settings", openSettings);
    return () => window.removeEventListener("open-security-settings", openSettings);
  }, [locked, setupMode]);

  useEffect(() => {
    let active = true;
    void localStore.getSecurityConfig().then((saved) => {
      if (!active) return;
      if (!saved) { setSetupMode(true); setReady(true); return; }
      setConfig(saved);
      setLocked(saved.enabled);
      setReady(true);
    }).catch(() => { if (active) { setError("Could not load local security settings."); setReady(true); } });
    return () => { active = false; };
  }, []);

  const lock = useCallback(() => {
    if (config?.enabled) { setLocked(true); setPin(""); setError(""); }
  }, [config]);

  useEffect(() => {
    if (!config?.enabled || locked || setupMode) return;
    const touch = () => { lastActivity.current = Date.now(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") lock(); else touch(); };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "touchstart", "scroll"];
    events.forEach((name) => window.addEventListener(name, touch, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(() => { if (Date.now() - lastActivity.current >= AUTO_LOCK_MS) lock(); }, 5000);
    return () => {
      events.forEach((name) => window.removeEventListener(name, touch));
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [config, locked, setupMode, lock]);

  const savePin = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!/^\d{4,6}$/.test(pin)) { setError("Enter a PIN of 4–6 digits."); return; }
    if (pin !== confirmPin) { setError("The PINs do not match."); return; }
    if (!crypto?.subtle) { setError("Secure PIN storage is not available in this browser."); return; }
    setBusy(true);
    try {
      const next = await createConfig(pin);
      await localStore.saveSecurityConfig(next);
      setConfig(next); setLocked(false); setSetupMode(false); setShowSettings(false); setPin(""); setConfirmPin(""); lastActivity.current = Date.now();
    } catch { setError("Could not save the PIN. Try again."); }
    finally { setBusy(false); }
  };

  const verifyPin = async (event: FormEvent) => {
    event.preventDefault();
    if (!config || !/^\d{4,6}$/.test(pin)) { setError("Enter your 4–6 digit PIN."); return; }
    setBusy(true); setError("");
    try {
      const candidate = await derivePin(pin, hexToBytes(config.salt), config.iterations);
      if (candidate !== config.hash) { setError("Incorrect PIN."); setPin(""); return; }
      setLocked(false); setPin(""); lastActivity.current = Date.now();
    } catch { setError("Could not verify PIN in this browser."); }
    finally { setBusy(false); }
  };

  const disablePin = async () => {
    await localStore.saveSecurityConfig({ salt: "", hash: "", iterations: ITERATIONS, enabled: false });
    setConfig({ salt: "", hash: "", iterations: ITERATIONS, enabled: false });
    setShowSettings(false); setSetupMode(false); setLocked(false);
  };

  if (!ready) return <div className="security-loading" role="status">Loading security settings…</div>;
  const showGate = setupMode || locked || showSettings;
  return <>
    {children}
    {showGate && <div className="security-backdrop" role="dialog" aria-modal="true" aria-labelledby="security-title">
      <section className="security-card">
        <div className="security-icon">⌑</div>
        <h1 id="security-title">{setupMode ? "Protect your backup" : locked ? "Gallery locked" : "Security settings"}</h1>
        <p>{setupMode ? "Set a local PIN to lock this gallery. Your Telegram connection and files will not change." : locked ? "Enter your PIN to continue." : "Your PIN is stored locally in this browser."}</p>
        {(setupMode || showSettings) && <form onSubmit={savePin} className="security-form">
          <label>New PIN<input inputMode="numeric" type="password" pattern="[0-9]*" autoComplete="new-password" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} placeholder="4–6 digits" required /></label>
          <label>Confirm PIN<input inputMode="numeric" type="password" pattern="[0-9]*" autoComplete="new-password" maxLength={6} value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ""))} placeholder="Repeat PIN" required /></label>
          <button className="security-primary" disabled={busy}>{busy ? "Saving…" : "Save PIN"}</button>
          {showSettings && <button type="button" className="security-secondary" onClick={() => { setShowSettings(false); setPin(""); setConfirmPin(""); setError(""); }}>Cancel</button>}
        </form>}
        {locked && !setupMode && <form onSubmit={verifyPin} className="security-form">
          <label>PIN<input autoFocus inputMode="numeric" type="password" pattern="[0-9]*" autoComplete="current-password" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} placeholder="Enter PIN" required /></label>
          <button className="security-primary" disabled={busy}>{busy ? "Checking…" : "Unlock"}</button>
        </form>}
        {error && <p className="security-error" role="alert">{error}</p>}
        {setupMode && <button className="security-secondary" onClick={async () => { await localStore.saveSecurityConfig({ salt: "", hash: "", iterations: ITERATIONS, enabled: false }); setConfig({ salt: "", hash: "", iterations: ITERATIONS, enabled: false }); setSetupMode(false); }}>Not now</button>}
        {!setupMode && !locked && showSettings && <button className="security-danger" onClick={() => void disablePin()}>Turn off PIN</button>}
        {locked && <small>PIN protection is local to this browser and is not an account-level security boundary.</small>}
      </section>
    </div>}

  </>;
}
