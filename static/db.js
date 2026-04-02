const DB_NAME = 'GottaBackhaulDB';
const DB_VERSION = 1;
const STORE_NAME = 'pending_pods';
let db;

function openDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            return resolve(db);
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error("IndexedDB error:", event.target.error);
            reject("IndexedDB error");
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
    });
}

async function savePodForSync(podData) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.add(podData);

        request.onsuccess = () => resolve();
        request.onerror = (event) => {
            console.error('Error saving POD to IndexedDB:', event.target.error);
            reject('Could not save POD for sync.');
        };
    });
}

async function getPendingPods() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject('Could not get pending PODs.');
    });
}

async function deletePendingPod(id) {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.delete(id);
}