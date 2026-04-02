/**
 * @jest-environment jsdom
 */

// Mock dependencies at the top level.
// These mocks will be used by the modules loaded via jest.isolateModulesAsync.
const mockApiFetch = jest.fn();
const mockShowNotification = jest.fn();

jest.mock('./apiUtil.js', () => ({
    apiFetch: mockApiFetch,
}));

jest.mock('./notifications.js', () => ({
    showNotification: mockShowNotification,
}));

// Mock the browser's Geolocation API
const mockGeolocation = {
    watchPosition: jest.fn(),
    clearWatch: jest.fn(),
};

// Use a getter for navigator.geolocation to make it configurable in tests
Object.defineProperty(window.navigator, 'geolocation', {
    value: mockGeolocation,
    writable: true,
});

// Mock the Wake Lock API
const mockWakeLock = { release: jest.fn().mockResolvedValue() };
Object.defineProperty(window.navigator, 'wakeLock', {
    value: { request: jest.fn().mockResolvedValue(mockWakeLock) },
    writable: true,
});

describe('driverTracking', () => {
    let watchPositionSuccessCallback;
    let watchPositionErrorCallback;
    const mockWatchId = 123;

    beforeEach(() => {
        // Clear all mocks before each test to ensure isolation
        jest.clearAllMocks();

        // Mock watchPosition to capture the success/error callbacks for simulation
        mockGeolocation.watchPosition.mockImplementation((success, error) => {
            watchPositionSuccessCallback = success;
            watchPositionErrorCallback = error;
            return mockWatchId; // Return a mock watch ID
        });

        // Default apiFetch to a resolved promise
        mockApiFetch.mockResolvedValue({});
    });

    describe('startDriverTracking', () => {
        // Helper function to load a fresh, non-cached instance of the driverTracking module.
        // This is necessary to reset the internal `currentStatus` and `watchId` state variables.
        async function getIsolatedDriverTracking() {
            return await jest.isolateModulesAsync(() => import('./driverTracking.js'));
        }

        it('should not start if geolocation is not supported', async () => {
            Object.defineProperty(window.navigator, 'geolocation', { value: undefined });
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            const { startDriverTracking } = await getIsolatedDriverTracking();
            startDriverTracking(1, 40.7128, -74.0060);

            expect(consoleWarnSpy).toHaveBeenCalledWith('Geolocation is not supported by your browser.');
            expect(mockGeolocation.watchPosition).not.toHaveBeenCalled();

            consoleWarnSpy.mockRestore();
            Object.defineProperty(window.navigator, 'geolocation', { value: mockGeolocation });
        });

        it('should start watching position with high accuracy', async () => {
            const { startDriverTracking } = await getIsolatedDriverTracking();
            startDriverTracking(1, 40.7128, -74.0060);

            expect(mockGeolocation.watchPosition).toHaveBeenCalledWith(
                expect.any(Function),
                expect.any(Function),
                {
                    enableHighAccuracy: true,
                    maximumAge: 10000,
                    timeout: 10000
                }
            );
        });

        it('should clear an existing watch before starting a new one', async () => {
            const { startDriverTracking } = await getIsolatedDriverTracking();
            
            startDriverTracking(1, 40.7128, -74.0060); // First call
            expect(mockGeolocation.clearWatch).not.toHaveBeenCalled();

            startDriverTracking(2, 34.0522, -118.2437); // Second call
            expect(mockGeolocation.clearWatch).toHaveBeenCalledWith(mockWatchId);
            expect(mockGeolocation.watchPosition).toHaveBeenCalledTimes(2);
        });

        it('should request a screen wake lock to prevent background throttling', async () => {
            const { startDriverTracking } = await getIsolatedDriverTracking();
            await startDriverTracking(1, 40.7128, -74.0060, 123);
            expect(window.navigator.wakeLock.request).toHaveBeenCalledWith('screen');
        });

        it('should gracefully handle Wake Lock request errors', async () => {
            window.navigator.wakeLock.request.mockRejectedValueOnce(new Error('Not Allowed'));
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const { startDriverTracking } = await getIsolatedDriverTracking();
            
            await startDriverTracking(1, 40.7128, -74.0060, 123);
            expect(consoleErrorSpy).toHaveBeenCalledWith('Could not request wake lock:', expect.any(Error));
            consoleErrorSpy.mockRestore();
        });

        describe('Geofencing Logic', () => {
            const destLat = 40.7128;
            const destLng = -74.0060; // NYC

            // Helper to simulate a driver's position update
            const simulatePositionUpdate = async (lat, lng) => {
                await watchPositionSuccessCallback({
                    coords: { latitude: lat, longitude: lng }
                });
            };

            it("should auto-update status to 'arrived' when driver enters the 500m geofence", async () => {
                const { startDriverTracking } = await getIsolatedDriverTracking();
                document.body.innerHTML = `<button id="btn-arrived-1"></button>`;
                startDriverTracking(1, destLat, destLng);

                // Simulate position just inside the geofence (~400m away)
                await simulatePositionUpdate(destLat + 0.0036, destLng);

                expect(mockShowNotification).toHaveBeenCalledWith("It looks like you're on site! Marking status as 'Arrived'...", 'info');
                expect(mockApiFetch).toHaveBeenCalledWith('/api/loads/1/arrived', { method: 'PATCH' });

                // Wait for async operations inside the callback to complete
                await new Promise(process.nextTick);

                expect(mockShowNotification).toHaveBeenCalledWith('Status updated to Arrived.', 'success');
                expect(document.getElementById('btn-arrived-1').disabled).toBe(true);
            });

            it("should not try to update to 'arrived' again if already arrived", async () => {
                const { startDriverTracking } = await getIsolatedDriverTracking();
                startDriverTracking(1, destLat, destLng);

                // 1. Arrive
                await simulatePositionUpdate(destLat + 0.001, destLng);
                await new Promise(process.nextTick); // Let the async api call finish
                
                // Clear mocks to check for subsequent calls
                mockApiFetch.mockClear();

                // 2. Move again, but still within the arrival zone
                await simulatePositionUpdate(destLat + 0.002, destLng);

                // Should not have been called again
                expect(mockApiFetch).not.toHaveBeenCalled();
            });

            it("should show a warning if driver leaves the site after arriving", async () => {
                const { startDriverTracking } = await getIsolatedDriverTracking();
                startDriverTracking(1, destLat, destLng);

                // 1. Arrive
                await simulatePositionUpdate(destLat + 0.001, destLng);
                await new Promise(process.nextTick);
                mockShowNotification.mockClear();

                // 2. Leave the site (move > 1000m away)
                await simulatePositionUpdate(destLat + 0.01, destLng);

                expect(mockShowNotification).toHaveBeenCalledWith("It looks like you left the site. Did you forget to tap 'Completed Loading'?", 'warning');
            });
        });

        describe('Background Location Sync', () => {
            beforeEach(() => {
                jest.useFakeTimers();
            });

            afterEach(() => {
                jest.clearAllTimers();
                jest.useRealTimers();
            });

            it('should sync location to backend every 30 seconds if truckId is provided', async () => {
                const { startDriverTracking } = await getIsolatedDriverTracking();
                await startDriverTracking(1, 40.7128, -74.0060, 99); // truckId = 99

                // Simulate the device receiving a GPS update
                await watchPositionSuccessCallback({
                    coords: { latitude: 40.75, longitude: -74.01 }
                });

                // Fast-forward time by 30 seconds to trigger the setInterval
                jest.advanceTimersByTime(30000);

                expect(mockApiFetch).toHaveBeenCalledWith('/api/trucks/99/location', {
                    method: 'PATCH',
                    body: { latitude: 40.75, longitude: -74.01 }
                });
            });
        });
    });

    describe('stopDriverTracking', () => {
        it('should clear the watch, stop the sync interval, and release wake lock', async () => {
            const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

            // Use the same isolated module instance to share the `watchId` state
            const { startDriverTracking, stopDriverTracking } = await jest.isolateModulesAsync(() => import('./driverTracking.js'));

            await startDriverTracking(1, 40.7128, -74.0060, 123);
            stopDriverTracking();

            expect(mockGeolocation.clearWatch).toHaveBeenCalledWith(mockWatchId);
            expect(clearIntervalSpy).toHaveBeenCalled();
            expect(mockWakeLock.release).toHaveBeenCalled();
            
            clearIntervalSpy.mockRestore();
        });
    });
});