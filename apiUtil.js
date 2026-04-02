let csrfTokenPromise = null;

/**
 * Fetches and caches the CSRF token. 
 * Caches the promise to prevent multiple simultaneous network requests.
 */
async function getCsrfToken() {
    if (csrfTokenPromise) {
        return csrfTokenPromise;
    }

    csrfTokenPromise = fetch('/api/csrf-token')
        .then(res => {
            if (!res.ok) {
                throw new Error(`HTTP error ${res.status}`);
            }
            return res.json();
        })
        .then(data => data.csrfToken)
        .catch(err => {
            console.error('Failed to fetch CSRF token:', err);
            csrfTokenPromise = null; // Reset so it can be retried later
            return null;
        });

    return csrfTokenPromise;
}

/**
 * Opens the IndexedDB used for Background Sync.
 */
function openSyncDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('SyncDB', 1);
        request.onupgradeneeded = event => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('requests')) {
                db.createObjectStore('requests', { keyPath: 'id', autoIncrement: true });
            }
        };
        request.onsuccess = event => resolve(event.target.result);
        request.onerror = event => reject(event.target.error);
    });
}

/**
 * Saves a failed mutating request to IndexedDB so the Service Worker can retry it later.
 */
async function saveRequestToSync(url, options) {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('requests', 'readwrite');
        const store = transaction.objectStore('requests');
        // Serialize the necessary options to safely store in IndexedDB
        const request = store.add({ url, options: { method: options.method, headers: options.headers, body: options.body }, timestamp: Date.now() });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Generic API utility for making fetch requests and handling errors uniformly.
 * 
 * @param {string} url - The API endpoint to fetch.
 * @param {Object} [options={}] - Fetch options (method, headers, body, etc.).
 * @returns {Promise<any>} - The parsed response data.
 * @throws {Error} - Throws an error with the server's message if the response is not ok.
 */
export async function apiFetch(url, options = {}) {
    try {
        options.headers = options.headers || {};

        // Automatically inject CSRF token into headers (except when fetching the token itself)
        if (url !== '/api/csrf-token') {
            const csrfToken = await getCsrfToken();
            if (csrfToken) {
                options.headers['x-csrf-token'] = csrfToken;
            }
        }

        // Automatically stringify plain objects and set Content-Type header
        if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
            options.body = JSON.stringify(options.body);
            options.headers = {
                'Content-Type': 'application/json',
                ...options.headers,
            };
        }

        let response;
        try {
            response = await fetch(url, options);
        } catch (networkError) {
            // If the fetch fails entirely (e.g., user is offline) and it's a mutating request, queue it
            const method = options.method ? options.method.toUpperCase() : 'GET';
            
            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
                // Check if the browser supports Service Workers and Background Sync
                if ('serviceWorker' in navigator && 'SyncManager' in window) {
                    if (options.body instanceof FormData) {
                        throw new Error("You are offline. File uploads cannot be queued for background sync.");
                    }

                    // Security: Prevent storing sensitive payloads (like passwords) in plain text in IndexedDB
                    const sensitiveEndpoints = ['/login', '/register', '/reset-password', '/change-password', '/csrf-token'];
                    if (sensitiveEndpoints.some(endpoint => url.includes(endpoint))) {
                        throw new Error("You are offline. This action contains sensitive data and cannot be queued safely.");
                    }

                    await saveRequestToSync(url, options);
                    const registration = await navigator.serviceWorker.ready;
                    await registration.sync.register('sync-mutations');
                    
                    throw new Error("You are offline. Your request has been queued and will sync when connection is restored.");
                }
            }
            throw networkError; // Re-throw for GET requests or if Sync isn't supported
        }

        // Safely parse the response depending on Content-Type
        const contentType = response.headers.get('content-type');
        const isJson = contentType && contentType.includes('application/json');
        
        let data;
        if (!response.ok) {
            data = isJson ? await response.json() : await response.text();
        } else if (options.responseType === 'blob') {
            data = await response.blob();
        } else {
            data = isJson ? await response.json() : await response.text();
        }

        // If the response status is outside the 200-299 range, throw an error
        if (!response.ok) {
            const errorMessage = (data && data.message) 
                ? data.message 
                : (typeof data === 'string' ? data : `HTTP Error ${response.status}: ${response.statusText}`);
            throw new Error(errorMessage);
        }

        return data;
    } catch (error) {
        // Optional: Global error logging or telemetry can be added here
        console.error(`[API Fetch Error] ${options.method || 'GET'} ${url}:`, error.message);
        throw error;
    }
}