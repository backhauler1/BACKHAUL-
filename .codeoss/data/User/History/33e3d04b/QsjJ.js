function registerServiceWorker() {
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        // Register the service worker
        navigator.serviceWorker.register('/static/sw.js')
            .then(registration => {
                console.log('Service Worker registered with scope:', registration.scope);
                return registration;
            })
            .catch(error => {
                console.error('Service Worker registration failed:', error);
            });
        
        // Listen for messages from the service worker (e.g., sync success)
        navigator.serviceWorker.addEventListener('message', event => {
            if (event.data && event.data.type === 'SYNC_SUCCESS') {
                // You could show a more sophisticated toast notification here
                alert(event.data.message);
            }
        });

    } else {
        console.log('Offline submission not supported: Service Worker or Background Sync not available.');
    }
}

async function requestBackgroundSync(tag) {
    const registration = await navigator.serviceWorker.ready;
    await registration.sync.register(tag);
    console.log(`Background sync for '${tag}' registered.`);
}

// Call registration on page load
registerServiceWorker();