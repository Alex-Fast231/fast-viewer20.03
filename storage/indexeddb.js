export const DB_NAME = "fast_doku_db";
export const DB_VERSION = 1;
export const STORE_SECURE = "secure";

let dbPromise = null;

export function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_SECURE)) {
        db.createObjectStore(STORE_SECURE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB konnte nicht geöffnet werden"));
  });

  return dbPromise;
}

function withStore(mode, callback) {
  return openDatabase().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SECURE, mode);
      const store = tx.objectStore(STORE_SECURE);

      let result;
      try {
        result = callback(store);
      } catch (err) {
        reject(err);
        return;
      }

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB Transaktionsfehler"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB Transaktion abgebrochen"));
    });
  });
}

export function getRecord(id) {
  return openDatabase().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SECURE, "readonly");
      const store = tx.objectStore(STORE_SECURE);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error || new Error(`Datensatz ${id} konnte nicht geladen werden`));
    });
  });
}

export function putRecord(id, value) {
  return withStore("readwrite", (store) => {
    store.put(value, id);
  });
}

export function deleteRecord(id) {
  return withStore("readwrite", (store) => {
    store.delete(id);
  });
}

export function clearStore() {
  return withStore("readwrite", (store) => {
    store.clear();
  });
}