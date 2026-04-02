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
        // Automatically stringify plain objects and set Content-Type header
        if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
            options.body = JSON.stringify(options.body);
            options.headers = {
                'Content-Type': 'application/json',
                ...options.headers,
            };
        }

        const response = await fetch(url, options);

        // Safely parse the response depending on Content-Type
        const contentType = response.headers.get('content-type');
        const isJson = contentType && contentType.includes('application/json');
        const data = isJson ? await response.json() : await response.text();

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