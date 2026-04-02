importScripts('/static/db.js');

const CACHE_NAME = 'gottabackhaul-cache-v1';

// On install, cache some static assets
self.addEventListener('install', (event) => {
    console.log('Service Worker: Installing...');
    // self.skipWaiting() should be used if you want the new service worker to activate immediately.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker: Activating...');
    return self.clients.claim();
});

self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-pending-pods') {
        console.log('Service Worker: Sync event for "sync-pending-pods" received');
        event.waitUntil(syncPendingPods());
    }
});

async function syncPendingPods() {
    const pendingPods = await getPendingPods();
    for (const pod of pendingPods) {
        console.log('Service Worker: Attempting to sync POD:', pod.id);
        try {
            const formData = new FormData();
            // Reconstruct FormData from the stored plain object
            for (const key in pod) {
                if (key === 'delivery_proof_pic' && pod[key] instanceof Blob) {
                     // The photo is stored as a Blob, append it with a filename
                    formData.append(key, pod[key], pod[key].name || 'pod.jpg');
                } else if (key !== 'id') { // don't send the local db id
                    formData.append(key, pod[key]);
                }
            }
            
            // The endpoint for POD submission is /delivery-confirmation
            const response = await fetch('/delivery-confirmation', {
                method: 'POST',
                body: formData,
            });

            if (response.ok) {
                console.log('Service Worker: Successfully synced POD:', pod.id);
                await deletePendingPod(pod.id);
                // Notify clients of success
                const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
                clients.forEach(client => client.postMessage({
                    type: 'SYNC_SUCCESS',
                    message: `Proof of Delivery for load ${pod.load_id} was successfully uploaded.`
                }));
            } else {
                console.error('Service Worker: Failed to sync POD:', pod.id, response.status, response.statusText);
                // If it's a client error (4xx), the server rejected it. Don't retry.
                if (response.status >= 400 && response.status < 500) {
                    console.log('Service Worker: Deleting unsyncable POD from queue:', pod.id);
                    await deletePendingPod(pod.id);
                }
            }
        } catch (error) {
            console.error('Service Worker: Error during POD sync:', error);
            // The sync will be retried automatically by the browser with exponential backoff.
        }
    }
}