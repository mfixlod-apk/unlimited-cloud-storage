import { useEffect, useState } from "react";
import { localStore } from "../storage";

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: { initTokenClient: (config: { client_id: string; scope: string; callback: (response: { access_token?: string; error?: string }) => void; error_callback?: (error: unknown) => void }) => { requestAccessToken: (options?: { prompt?: string }) => void } } } };
  }
}
type Props = { onClose: () => void; onImportFiles: (files: File[]) => void };
type PickerSession = { id: string; pickerUri: string; mediaItemsSet?: boolean; expireTime?: string };
type PickedMedia = { id: string; mediaFile?: { filename?: string; mimeType?: string; baseUrl?: string }; mediaMetadata?: { creationTime?: string; width?: string; height?: string } };

const API = "https://photospicker.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-google-identity="true"]');
    const script = existing || document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.onload = () => window.google?.accounts?.oauth2 ? resolve() : reject(new Error("Google sign-in did not initialize."));
    script.onerror = () => reject(new Error("Could not load Google sign-in."));
    if (!existing) document.head.appendChild(script);
  });
}
function wait(ms: number) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

export function GooglePhotosImport({ onClose, onImportFiles }: Props) {
  const [clientId, setClientId] = useState("");
  const [session, setSession] = useState<PickerSession>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState(false);

  useEffect(() => { void localStore.getGooglePhotosClientId().then((value) => { if (value) { setClientId(value); setConfigured(true); } }).catch(() => undefined); }, []);

  const startPicker = async () => {
    setBusy(true); setError(""); setStatus("Opening Google sign-in…");
    try {
      if (!clientId.trim().endsWith(".apps.googleusercontent.com")) throw new Error("Enter a valid Google OAuth Web client ID first.");
      await localStore.saveGooglePhotosClientId(clientId.trim());
      await loadGoogleIdentity();
      const token = await new Promise<string>((resolve, reject) => {
        const oauth = window.google?.accounts?.oauth2;
        if (!oauth) { reject(new Error("Google sign-in is unavailable.")); return; }
        const client = oauth.initTokenClient({ client_id: clientId.trim(), scope: SCOPE, callback: (response) => response.access_token ? resolve(response.access_token) : reject(new Error(response.error || "Google authorization failed.")), error_callback: () => reject(new Error("Google authorization was cancelled or blocked.")) });
        client.requestAccessToken({ prompt: "consent" });
      });
      setStatus("Creating a secure Google Photos selection session…");
      const response = await fetch(`${API}/sessions`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error(`Google Photos session failed (${response.status}). Check that Photos Picker API is enabled for this Google project.`);
      const created = await response.json() as PickerSession;
      setSession(created);
      setStatus("Open Google Photos using the button below, select photos or videos, then return here and press Check selection.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Google Photos import failed."); }
    finally { setBusy(false); }
  };

  const fetchSelection = async () => {
    if (!session) return;
    setBusy(true); setError(""); setStatus("Checking whether you finished selecting media…");
    try {
      await loadGoogleIdentity();
      const token = await new Promise<string>((resolve, reject) => {
        const oauth = window.google?.accounts?.oauth2;
        if (!oauth) { reject(new Error("Google sign-in is unavailable.")); return; }
        const client = oauth.initTokenClient({ client_id: clientId.trim(), scope: SCOPE, callback: (response) => response.access_token ? resolve(response.access_token) : reject(new Error(response.error || "Google authorization failed.")), error_callback: () => reject(new Error("Google authorization was cancelled.")) });
        client.requestAccessToken({ prompt: "" });
      });
      let ready = false;
      for (let i = 0; i < 12; i += 1) {
        const response = await fetch(`${API}/sessions/${encodeURIComponent(session.id)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`Could not check Google Photos selection (${response.status}).`);
        const current = await response.json() as PickerSession;
        if (current.mediaItemsSet) { ready = true; break; }
        await wait(2000);
      }
      if (!ready) { setStatus("Selection is not ready yet. Finish selecting in Google Photos, then check again."); return; }
      const picked: PickedMedia[] = [];
      let pageToken = "";
      for (let page = 0; page < 10; page += 1) {
        const url = new URL(`${API}/mediaItems`);
        url.searchParams.set("sessionId", session.id);
        url.searchParams.set("pageSize", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`Could not list selected media (${response.status}).`);
        const result = await response.json() as { mediaItems?: PickedMedia[]; nextPageToken?: string };
        picked.push(...(result.mediaItems || []));
        if (!result.nextPageToken) break;
        pageToken = result.nextPageToken;
      }
      if (!picked.length) throw new Error("Google Photos returned no selected files.");
      setStatus(`Downloading ${picked.length} selected file(s) from Google Photos…`);
      const files: File[] = [];
      for (const item of picked) {
        const media = item.mediaFile;
        if (!media?.baseUrl) continue;
        const mime = media.mimeType || "application/octet-stream";
        const url = media.baseUrl + (mime.startsWith("video/") ? "=dv" : "=d");
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not download ${media.filename || "a selected file"} (${response.status}).`);
        const blob = await response.blob();
        files.push(new File([blob], media.filename || `google-photos-${item.id}`, { type: mime, lastModified: item.mediaMetadata?.creationTime ? Date.parse(item.mediaMetadata.creationTime) : Date.now() }));
      }
      if (!files.length) throw new Error("No media files could be downloaded from the selection.");
      onImportFiles(files);
      setStatus(`Added ${files.length} file(s) to the existing Telegram upload queue.`);
      setSession(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not import the selection."); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop google-photos-backdrop" role="dialog" aria-modal="true" aria-labelledby="google-photos-title">
    <section className="google-photos-card">
      <header><div><span className="eyebrow">IMPORT MEDIA</span><h2 id="google-photos-title">Google Photos</h2></div><button onClick={onClose} aria-label="Close">×</button></header>
      <p>Choose items in Google Photos and send them into your existing Telegram backup queue. Files are downloaded in this browser; no application server is used.</p>
      <label className="google-client-label">Google OAuth Web client ID<input value={clientId} onChange={(event) => { setClientId(event.target.value); setConfigured(false); }} placeholder="…apps.googleusercontent.com" autoComplete="off" /></label>
      <small>Requires a Google Cloud project with Photos Picker API enabled and this site's origin added to the OAuth client. The client ID is public configuration; never enter a client secret here.</small>
      <button className="google-primary" onClick={() => void startPicker()} disabled={busy || !clientId.trim()}>{busy ? "Working…" : configured ? "Connect / open Google Photos" : "Save client ID and connect"}</button>
      {session && <div className="google-session"><a href={session.pickerUri} target="_blank" rel="noreferrer">Open Google Photos picker ↗</a><p>After selecting items and confirming in Google Photos, return here.</p><button className="google-primary" onClick={() => void fetchSelection()} disabled={busy}>{busy ? "Checking…" : "Check selection and import"}</button></div>}
      {status && <p className="google-status" role="status">{status}</p>}
      {error && <p className="google-error" role="alert">{error}</p>}
      <footer>Imports are queued for Telegram using the existing upload system. Review the queue before leaving this page.</footer>
    </section>
  </div>;
}
