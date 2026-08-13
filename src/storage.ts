import { openDB, type DBSchema } from "idb";

export interface SavedConnection {
  apiId: number;
  apiHash: string;
  session: string;
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
}

const dbPromise = openDB<CloudDb>("unlimited-cloud-storage", 3, {
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
  getThumbnail: (key: string) => dbPromise.then((db) => db.get("thumbnails", key)),
  saveThumbnail: (key: string, blob: Blob) => dbPromise.then((db) => db.put("thumbnails", blob, key)),
  deleteThumbnail: (key: string) => dbPromise.then((db) => db.delete("thumbnails", key)),
  clearThumbnails: () => dbPromise.then((db) => db.clear("thumbnails")),
  clearAll: async () => {
    const db = await dbPromise;
    const tx = db.transaction(["config", "thumbnails"], "readwrite");
    await Promise.all([tx.objectStore("config").clear(), tx.objectStore("thumbnails").clear(), tx.done]);
  },
};
