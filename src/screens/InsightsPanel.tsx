import { useMemo, useState } from "react";
import type { CloudItem } from "../telegram";
import type { SavedAlbum } from "../storage";
import { formatDate, formatSize } from "./shared";

type Props = {
  items: CloudItem[];
  favoriteIds: number[];
  verifiedIds: number[];
  albums: SavedAlbum[];
  selectedIds: number[];
  verificationBusy: boolean;
  verificationMessage: string;
  faceBusy: boolean;
  faceMessage: string;
  onTryFaceDetection: () => void;
  onVerifySelected: () => void;
  onClose: () => void;
  onToggleFavorite: (item: CloudItem) => void;
  onCreateAlbum: (title: string, itemIds: number[]) => void;
  onOpenItem: (item: CloudItem) => void;
  onOpenAlbum: (album: SavedAlbum) => void;
};

const dayKey = (date: Date) => `${date.getMonth()}-${date.getDate()}`;
const normalizeName = (name: string) => name.toLocaleLowerCase().replace(/\s*\(\d+\)(?=\.[^.]+$)/, "").replace(/[-_ ]copy(?=\.[^.]+$)/, "");

export function InsightsPanel({ items, favoriteIds, verifiedIds, albums, selectedIds, verificationBusy, verificationMessage, faceBusy, faceMessage, onTryFaceDetection, onVerifySelected, onClose, onToggleFavorite, onCreateAlbum, onOpenItem, onOpenAlbum }: Props) {
  const [albumTitle, setAlbumTitle] = useState("");
  const favorites = useMemo(() => items.filter((item) => favoriteIds.includes(item.id)), [items, favoriteIds]);
  const memories = useMemo(() => {
    const now = new Date();
    return items.filter((item) => {
      const date = item.date;
      return date.getFullYear() < now.getFullYear() && dayKey(date) === dayKey(now);
    }).sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 8);
  }, [items]);
  const duplicates = useMemo(() => {
    const groups = new Map<string, CloudItem[]>();
    for (const item of items) {
      if (!item.size) continue;
      const key = `${item.size}:${normalizeName(item.name)}`;
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
    return Array.from(groups.values()).filter((group) => group.length > 1).flat().slice(0, 30);
  }, [items]);
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  const FaceDetectorApi = (window as Window & { FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => unknown }).FaceDetector;
  const canTryFaceDetection = typeof FaceDetectorApi === "function";

  return <div className="modal-backdrop insights-backdrop" role="dialog" aria-modal="true" aria-label="Backup insights" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="insights-panel">
      <header className="insights-header"><div><span className="eyebrow">YOUR PRIVATE LIBRARY</span><h2>Backup dashboard</h2><p>Statistics are based on the files currently loaded from Telegram.</p></div><button className="bulk-close" onClick={onClose} aria-label="Close dashboard">×</button></header>
      <div className="insights-stats">
        <article><strong>{items.length.toLocaleString()}</strong><span>Loaded files</span></article>
        <article><strong>{formatSize(totalBytes)}</strong><span>Known file sizes</span></article>
        <article><strong>{favoriteIds.length.toLocaleString()}</strong><span>Favorites saved</span></article>
        <article><strong>{verifiedIds.length.toLocaleString()}</strong><span>Size-verified</span></article>
      </div>
      <section className="insights-section"><h3>Backup integrity check</h3><p>Download up to 10 selected Telegram files and compare their downloaded size with the size recorded in Telegram. This confirms basic readability and size, not a byte-for-byte match with the original iPhone file.</p><button className="insights-verify-button" onClick={onVerifySelected} disabled={!selectedIds.length || verificationBusy}>{verificationBusy ? "Checking…" : `Check selected files (${Math.min(selectedIds.length, 10)} max)`}</button>{verificationMessage && <p className="insights-verification-message" role="status">{verificationMessage}</p>}</section>
      <section className="insights-section"><h3>Albums</h3><p>Create an album from the items you selected in the gallery.</p><form className="insights-create-album" onSubmit={(event) => { event.preventDefault(); const title = albumTitle.trim(); if (!title || !selectedIds.length) return; onCreateAlbum(title, selectedIds); setAlbumTitle(""); }}><input value={albumTitle} onChange={(event) => setAlbumTitle(event.target.value)} placeholder="Album name" maxLength={60} aria-label="Album name" /><button type="submit" disabled={!albumTitle.trim() || !selectedIds.length}>Create from {selectedIds.length} selected</button></form>{albums.length ? <div className="insights-albums">{albums.map((album) => <button key={album.id} onClick={() => onOpenAlbum(album)}><strong>{album.title}</strong><span>{album.itemIds.length} items</span></button>)}</div> : <p className="insights-muted">No albums yet. Select files in the gallery first.</p>}</section>
      <section className="insights-section"><h3>Memories from this day</h3>{memories.length ? <div className="insights-list">{memories.map((item) => <button key={item.id} onClick={() => onOpenItem(item)}><span><strong>{item.name}</strong><small>{formatDate(item.date)}</small></span><small>{formatSize(item.size)}</small></button>)}</div> : <p className="insights-muted">No older files from today’s date are in the currently loaded history.</p>}</section>
      <section className="insights-section"><h3>Possible duplicates</h3><p>These are candidates with matching file size and similar names, not confirmed byte-for-byte duplicates. Nothing is deleted automatically.</p>{duplicates.length ? <div className="insights-list">{duplicates.map((item) => <button key={item.id} onClick={() => onOpenItem(item)}><span><strong>{item.name}</strong><small>{formatDate(item.date)}</small></span><small>{formatSize(item.size)}</small></button>)}</div> : <p className="insights-muted">No likely duplicates found in the loaded items.</p>}</section>
      <section className="insights-section"><h3>Favorites</h3>{favorites.length ? <div className="insights-list">{favorites.slice(0, 12).map((item) => <div className="insights-favorite" key={item.id}><button className="insights-favorite-open" onClick={() => onOpenItem(item)}><strong>{item.name}</strong><small>{formatDate(item.date)}</small></button><button onClick={() => onToggleFavorite(item)} aria-label={`Remove ${item.name} from favorites`}>★</button></div>)}</div> : <p className="insights-muted">Mark a file as a favorite from its card menu.</p>}</section>
      <section className="insights-section"><h3>Map and face search</h3><div className="insights-capability"><strong>Photo map</strong><p>The current Telegram index stores file name, date and size, but not GPS coordinates. A map can be populated after adding safe EXIF-location extraction.</p></div><div className="insights-capability"><strong>Local face detection experiment</strong><p>{canTryFaceDetection ? "Try detecting faces in the thumbnail of a selected image. Processing runs locally and results are not saved." : "Face detection is not exposed by this browser (common in iPhone Safari). No face data is uploaded or sent anywhere. A compatible local model would be needed to support this browser."}</p><button className="insights-verify-button" onClick={onTryFaceDetection} disabled={!canTryFaceDetection || !selectedIds.length || faceBusy}>{faceBusy ? "Testing locally…" : "Test on selected image"}</button>{faceMessage && <p className="insights-verification-message" role="status">{faceMessage}</p>}</div></section>
      <footer className="insights-footer">Favorites and albums are stored locally in this browser. They do not create copies of files in Telegram.</footer>
    </section>
  </div>;
}
