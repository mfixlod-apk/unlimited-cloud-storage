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

const dbPromise = openDB<CloudDb>("unlimited-cloud-storage", 1, {
  upgrade(db) {
    db.createObjectStore("config");
    db.createObjectStore("thumbnails");
  },
});

export const localStore = {
  getConnection: () => dbPromise.then((db) => db.get("config", "connection") as Promise<SavedConnection | undefined>),
  saveConnection: (value: SavedConnection) => dbPromise.then((db) => db.put("config", value, "connection")),
  clearConnection: () => dbPromise.then((db) => db.delete("config", "connection")),
  getChannelId: () => dbPromise.then((db) => db.get("config", "channelId") as Promise<string | undefined>),
  saveChannelId: (id: string) => dbPromise.then((db) => db.put("config", id, "channelId")),
  clearChannelId: () => dbPromise.then((db) => db.delete("config", "channelId")),
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
