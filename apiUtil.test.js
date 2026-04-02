/**
 * @jest-environment jsdom
 */

describe('apiUtil.js', () => {
    let consoleErrorSpy;

    // Helper to simulate browser's fetch response
    const mockResponse = (ok, body, contentType = 'application/json', status = 200, statusText = 'OK') => ({
        ok,
        status,
        statusText,
        headers: {
            get: (header) => header.toLowerCase() === 'content-type' ? contentType : null,
        },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
        blob: () => Promise.resolve(new Blob([typeof body === 'string' ? body : JSON.stringify(body)], { type: contentType })),
    });

    beforeEach(() => {
        global.fetch = jest.fn();
        // Suppress expected error logs to keep test output clean
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // Helper to load apiFetch freshly for each test, resetting internal `csrfTokenPromise` state
    const getIsolatedApiFetch = async () => {
        let isolatedFetch;
        await jest.isolateModulesAsync(async () => {
            const module = await import('./apiUtil.js');
            isolatedFetch = module.apiFetch;
        });
        return isolatedFetch;
    };

    describe('CSRF Token Handling', () => {
        it('should automatically fetch and inject the CSRF token into headers', async () => {
            const apiFetch = await getIsolatedApiFetch();
            
            global.fetch.mockImplementation((url) => {
                if (url === '/api/csrf-token') return Promise.resolve(mockResponse(true, { csrfToken: 'mock-token-123' }));
                return Promise.resolve(mockResponse(true, { success: true }));
            });

            await apiFetch('/api/data');

            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect(global.fetch).toHaveBeenNthCalledWith(1, '/api/csrf-token');
            expect(global.fetch).toHaveBeenNthCalledWith(2, '/api/data', expect.objectContaining({
                headers: expect.objectContaining({ 'x-csrf-token': 'mock-token-123' })
            }));
        });

        it('should cache the CSRF token and only fetch it once for multiple requests', async () => {
            const apiFetch = await getIsolatedApiFetch();
            
            global.fetch.mockImplementation((url) => {
                if (url === '/api/csrf-token') return Promise.resolve(mockResponse(true, { csrfToken: 'cached-token' }));
                return Promise.resolve(mockResponse(true, {}));
            });

            await apiFetch('/api/route1');
            await apiFetch('/api/route2');

            // 1 CSRF fetch + 2 API calls = 3 total fetch calls
            expect(global.fetch).toHaveBeenCalledTimes(3);
            
            // Verify CSRF was only called the very first time
            const csrfCalls = global.fetch.mock.calls.filter(call => call[0] === '/api/csrf-token');
            expect(csrfCalls.length).toBe(1);
            
            // Verify both subsequent calls used the cached token
            expect(global.fetch.mock.calls[1][1].headers['x-csrf-token']).toBe('cached-token');
            expect(global.fetch.mock.calls[2][1].headers['x-csrf-token']).toBe('cached-token');
        });

        it('should gracefully handle CSRF token fetch failures and proceed without the token', async () => {
            const apiFetch = await getIsolatedApiFetch();
            
            global.fetch.mockImplementation((url) => {
                if (url === '/api/csrf-token') return Promise.reject(new Error('Network error'));
                return Promise.resolve(mockResponse(true, { data: 'fallback' }));
            });

            const data = await apiFetch('/api/no-csrf');
            
            expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch CSRF token:', expect.any(Error));
            expect(data).toEqual({ data: 'fallback' });
            
            const apiCall = global.fetch.mock.calls.find(call => call[0] === '/api/no-csrf');
            expect(apiCall[1].headers['x-csrf-token']).toBeUndefined();
        });

        it('should not attempt to inject a CSRF token when explicitly fetching the token itself', async () => {
            const apiFetch = await getIsolatedApiFetch();
            global.fetch.mockResolvedValue(mockResponse(true, { csrfToken: 'new-token' }));

            await apiFetch('/api/csrf-token');

            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(global.fetch.mock.calls[0][1].headers['x-csrf-token']).toBeUndefined();
        });
    });

    describe('Request Formatting', () => {
        it('should stringify plain JavaScript objects and set Content-Type to application/json', async () => {
            const apiFetch = await getIsolatedApiFetch();
            global.fetch.mockResolvedValue(mockResponse(true, {}));

            await apiFetch('/api/post', { method: 'POST', body: { name: 'Test' } });

            const fetchCall = global.fetch.mock.calls.find(call => call[0] === '/api/post');
            expect(fetchCall[1].body).toBe('{"name":"Test"}');
            expect(fetchCall[1].headers['Content-Type']).toBe('application/json');
        });

        it('should not stringify FormData objects or override their Content-Type', async () => {
            const apiFetch = await getIsolatedApiFetch();
            global.fetch.mockResolvedValue(mockResponse(true, {}));

            const formData = new FormData();
            formData.append('file', 'dummy_content');

            await apiFetch('/api/upload', { method: 'POST', body: formData });

            const fetchCall = global.fetch.mock.calls.find(call => call[0] === '/api/upload');
            expect(fetchCall[1].body).toBeInstanceOf(FormData);
            // Browser dynamically adds Content-Type with boundary for FormData
            expect(fetchCall[1].headers['Content-Type']).toBeUndefined(); 
        });

        it('should preserve existing custom headers', async () => {
            const apiFetch = await getIsolatedApiFetch();
            global.fetch.mockResolvedValue(mockResponse(true, {}));

            await apiFetch('/api/auth-route', { headers: { 'Authorization': 'Bearer XYZ' } });

            const fetchCall = global.fetch.mock.calls.find(call => call[0] === '/api/auth-route');
            expect(fetchCall[1].headers['Authorization']).toBe('Bearer XYZ');
        });
    });

    describe('Response Parsing and Error Handling', () => {
        it('should parse responses as text if Content-Type is not application/json', async () => {
            const apiFetch = await getIsolatedApiFetch();
            global.fetch.mockResolvedValue(mockResponse(true, 'HTML or Plain Text', 'text/html'));

            const data = await apiFetch('/api/page');
            expect(data).toBe('HTML or Plain Text');
        });

        it('should parse responses as a Blob if options.responseType is blob', async () => {
            const apiFetch = await getIsolatedApiFetch();
            global.fetch.mockResolvedValue(mockResponse(true, 'mock,csv', 'text/csv'));

            const data = await apiFetch('/api/download', { responseType: 'blob' });
            expect(data).toBeInstanceOf(Blob);
        });

        it('should throw an error containing the server message if the JSON response is not ok', async () => {
            const apiFetch = await getIsolatedApiFetch();
            global.fetch.mockResolvedValue(mockResponse(false, { message: 'Invalid credentials' }, 'application/json', 401));

            await expect(apiFetch('/api/login')).rejects.toThrow('Invalid credentials');
            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[API Fetch Error]'), 'Invalid credentials');
        });

        it('should throw an error with the text string if response is not ok and no message prop exists', async () => {
            const apiFetch = await getIsolatedApiFetch();
            global.fetch.mockResolvedValue(mockResponse(false, 'Bad Gateway Error Text', 'text/plain', 502));

            await expect(apiFetch('/api/broken')).rejects.toThrow('Bad Gateway Error Text');
        });

        it('should fallback to HTTP status and text if no body information is provided', async () => {
            const apiFetch = await getIsolatedApiFetch();
            global.fetch.mockResolvedValue(mockResponse(false, {}, 'application/json', 404, 'Not Found'));

            await expect(apiFetch('/api/missing')).rejects.toThrow('HTTP Error 404: Not Found');
        });
    });
});