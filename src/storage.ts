import { openDB, type DBSchema } from "idb";

export interface SavedConnection {
  apiId: number;
  apiHash: string;
  session: string;
}

export type UploadQueueStatus = "queued" | "uploading" | "retrying" | "needs-file" | "done" | "failed";

export interface UploadQueueRecord {
  id: string;
  channelId: string;
  batchId: string;
  fingerprint: string;
  sourceName?: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  relativePath: string;
  status: UploadQueueStatus;
  attempts: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface SavedAlbum {
  id: string;
  title: string;
  itemIds: number[];
  createdAt: number;
  parentId?: string;
  isVault?: boolean;
}

export interface GalleryMetadata {
  favoriteIds: number[];
  verifiedIds: number[];
  albums: SavedAlbum[];
}

export interface UploadBatchRecord {
  id: string;
  channelId: string;
  status: "active" | "completed";
  fileCount: number;
  totalBytes: number;
  sourceOldest?: number;
  sourceNewest?: number;
  createdAt: number;
  completedAt?: number;
  checkpointSent: boolean;
}

interface CloudDb extends DBSchema {
  config: {
    key: string;
    value: unknown;
  };
  thumbnails: {
    key: string;
    value: Blob;
  };
  uploadQueue: {
    key: string;
    value: UploadQueueRecord;
    indexes: { "by-channel": string; "by-batch": string };
  };
  uploadBatches: {
    key: string;
    value: UploadBatchRecord;
    indexes: { "by-channel": string };
  };
}

const dbPromise = openDB<CloudDb>("unlimited-cloud-storage", 4, {
  upgrade(db, oldVersion, _newVersion, transaction) {
    if (oldVersion < 1) {
      db.createObjectStore("config");
      db.createObjectStore("thumbnails");
    }
    if (oldVersion >= 1 && oldVersion < 2) {
      // Drop the former smallest-resolution cache while retaining sessions
      // and the selected channel during the thumbnail-quality upgrade.
      transaction.objectStore("thumbnails").clear();
    }
    if (oldVersion >= 2 && oldVersion < 3) {
      // Remove thumbnail blobs produced by the older non-retrying renderer.
      transaction.objectStore("thumbnails").clear();
    }
    if (oldVersion < 4) {
      const queue = db.createObjectStore("uploadQueue", { keyPath: "id" });
      queue.createIndex("by-channel", "channelId");
      queue.createIndex("by-batch", "batchId");
      const batches = db.createObjectStore("uploadBatches", { keyPath: "id" });
      batches.createIndex("by-channel", "channelId");
    }
  },
});

export const localStore = {
  getConnection: () => dbPromise.then((db) => db.get("config", "connection") as Promise<SavedConnection | undefined>),
  saveConnection: (value: SavedConnection) => dbPromise.then((db) => db.put("config", value, "connection")),
  clearConnection: () => dbPromise.then((db) => db.delete("config", "connection")),
  getChannelId: () => dbPromise.then((db) => db.get("config", "channelId") as Promise<string | undefined>),
  saveChannelId: (id: string) => dbPromise.then((db) => db.put("config", id, "channelId")),
  clearChannelId: () => dbPromise.then((db) => db.delete("config", "channelId")),
  getMemoryLimitMb: () => dbPromise.then(async (db) => Number(await db.get("config", "memoryLimitMb")) || 1024),
  saveMemoryLimitMb: (value: number) => dbPromise.then((db) => db.put("config", value, "memoryLimitMb")),
  getPreventDuplicateNames: () => dbPromise.then(async (db) => Boolean(await db.get("config", "preventDuplicateNames"))),
  savePreventDuplicateNames: (value: boolean) => dbPromise.then((db) => db.put("config", value, "preventDuplicateNames")),
  getDatePrefixUploads: () => dbPromise.then(async (db) => Boolean(await db.get("config", "datePrefixUploads"))),
  saveDatePrefixUploads: (value: boolean) => dbPromise.then((db) => db.put("config", value, "datePrefixUploads")),
  getGalleryMetadata: (channelId: string) => dbPromise.then(async (db) => {
    const value = await db.get("config", `galleryMetadata:${channelId}`) as GalleryMetadata | undefined;
    return value || { favoriteIds: [], verifiedIds: [], albums: [] };
  }),
  saveGalleryMetadata: (channelId: string, value: GalleryMetadata) => dbPromise.then((db) => db.put("config", value, `galleryMetadata:${channelId}`)),
  getSecurityConfig: () => dbPromise.then(async (db) => (await db.get("config", "securityConfig")) as { salt: string; hash: string; iterations: number; enabled: boolean } | undefined),
  saveSecurityConfig: (value: { salt: string; hash: string; iterations: number; enabled: boolean }) => dbPromise.then((db) => db.put("config", value, "securityConfig")),
  getVaultPinConfig: () => dbPromise.then(async (db) => (await db.get("config", "vaultPinConfig")) as { salt: string; hash: string; iterations: number } | undefined),
  saveVaultPinConfig: (value: { salt: string; hash: string; iterations: number }) => dbPromise.then((db) => db.put("config", value, "vaultPinConfig")),
  getGooglePhotosClientId: () => dbPromise.then(async (db) => (await db.get("config", "googlePhotosClientId")) as string | undefined),
  saveGooglePhotosClientId: (value: string) => dbPromise.then((db) => db.put("config", value, "googlePhotosClientId")),
  getTheme: () => dbPromise.then(async (db) => {
    const value = await db.get("config", "theme");
    return value === "dark" || value === "light" ? value : undefined;
  }),
  saveTheme: (value: "light" | "dark") => dbPromise.then((db) => db.put("config", value, "theme")),
  getThumbnail: (key: string) => dbPromise.then((db) => db.get("thumbnails", key)),
  saveThumbnail: (key: string, blob: Blob) => dbPromise.then((db) => db.put("thumbnails", blob, key)),
  deleteThumbnail: (key: string) => dbPromise.then((db) => db.delete("thumbnails", key)),
  clearThumbnails: () => dbPromise.then((db) => db.clear("thumbnails")),
  getUploadRecords: (channelId: string) => dbPromise.then((db) => db.getAllFromIndex("uploadQueue", "by-channel", channelId)),
  getUploadBatchRecords: (batchId: string) => dbPromise.then((db) => db.getAllFromIndex("uploadQueue", "by-batch", batchId)),
  saveUploadRecord: (record: UploadQueueRecord) => dbPromise.then((db) => db.put("uploadQueue", record)),
  saveUploadRecords: async (records: UploadQueueRecord[]) => {
    if (!records.length) return;
    const db = await dbPromise;
    const tx = db.transaction("uploadQueue", "readwrite");
    for (const record of records) void tx.store.put(record);
    await tx.done;
  },
  deleteUploadRecords: async (ids: string[]) => {
    if (!ids.length) return;
    const db = await dbPromise;
    const tx = db.transaction("uploadQueue", "readwrite");
    for (const id of ids) void tx.store.delete(id);
    await tx.done;
  },
  getUploadBatches: (channelId: string) => dbPromise.then((db) => db.getAllFromIndex("uploadBatches", "by-channel", channelId)),
  saveUploadBatch: (batch: UploadBatchRecord) => dbPromise.then((db) => db.put("uploadBatches", batch)),
  deleteUploadBatch: (id: string) => dbPromise.then((db) => db.delete("uploadBatches", id)),
  saveUploadBatchWithRecords: async (batch: UploadBatchRecord, records: UploadQueueRecord[]) => {
    const db = await dbPromise;
    const tx = db.transaction(["uploadQueue", "uploadBatches"], "readwrite");
    void tx.objectStore("uploadBatches").put(batch);
    for (const record of records) void tx.objectStore("uploadQueue").put(record);
    await tx.done;
  },
  clearAll: async () => {
    const db = await dbPromise;
    const tx = db.transaction(["config", "thumbnails", "uploadQueue", "uploadBatches"], "readwrite");
    await Promise.all([
      tx.objectStore("config").clear(),
      tx.objectStore("thumbnails").clear(),
      tx.objectStore("uploadQueue").clear(),
      tx.objectStore("uploadBatches").clear(),
      tx.done,
    ]);
  },
};
