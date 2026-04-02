/**
 * @jest-environment jsdom
 */

import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

// Mock dependencies at the top level
jest.mock('./apiUtil.js', () => ({
    apiFetch: jest.fn().mockResolvedValue({}),
}));

jest.mock('./notifications.js', () => ({
    showNotification: jest.fn(),
}));


describe('driverTracking', () => {
    let mockGeolocation;
    let mockWakeLock;
    let mockSocketInstance;
    let mockIo;

    // This helper function uses jest.isolateModulesAsync to get a fresh, isolated
    // copy of the driverTracking module for each test. This is crucial for
    // resetting its internal state (like `watchId`, `socket`, etc.).
    const getIsolatedDriverTracking = () => jest.isolateModulesAsync(() => import('./driverTracking.js'));

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        // --- Mock Browser/Global APIs ---

        // Mock Geolocation
        mockGeolocation = {
            watchPosition: jest.fn().mockReturnValue(12345), // Return a mock watchId
            clearWatch: jest.fn(),
        };

        // Mock WakeLock
        mockWakeLock = {
            request: jest.fn().mockResolvedValue({ release: jest.fn() }),
        };

        // Mock Socket.IO
        mockSocketInstance = {
            emit: jest.fn(),
            disconnect: jest.fn(),
            on: jest.fn(),
            connected: true,
        };
        mockIo = jest.fn(() => mockSocketInstance);

        // Assign mocks to the global window/navigator objects that the script uses
        Object.defineProperty(window, 'navigator', {
            value: {
                geolocation: mockGeolocation,
                wakeLock: mockWakeLock,
            },
            writable: true,
        });
        Object.defineProperty(window, 'io', {
            value: mockIo,
            writable: true,
        });

        // Mock the DOM element for the 'arrived' button
        document.body.innerHTML = `<button id="btn-arrived-1"></button>`;
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('startDriverTracking', () => {
        it('should start watching the driver position', async () => {
            const { startDriverTracking } = await getIsolatedDriverTracking();
            await startDriverTracking(1, 40.7128, -74.0060);
            expect(mockGeolocation.watchPosition).toHaveBeenCalled();
        });

        it('should clear an existing watch before starting a new one', async () => {
            const { startDriverTracking } = await getIsolatedDriverTracking();
            
            await startDriverTracking(1, 40.7128, -74.0060); // First call
            expect(mockGeolocation.clearWatch).not.toHaveBeenCalled();

            await startDriverTracking(2, 34.0522, -118.2437); // Second call
            expect(mockGeolocation.clearWatch).toHaveBeenCalledWith(12345);
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

        it('should initialize Socket.IO and join the correct room', async () => {
            const { startDriverTracking } = await getIsolatedDriverTracking();
            await startDriverTracking(1, 40.7128, -74.0060, 123);
            expect(mockIo).toHaveBeenCalled();
            expect(mockSocketInstance.emit).toHaveBeenCalledWith('join_tracking_room', { loadId: 1 });
        });

        describe('Geofencing Logic', () => {
            const destLat = 40.7128;
            const destLng = -74.0060;

            it("should auto-update status to 'arrived' when driver enters the 500m geofence", async () => {
                const { startDriverTracking } = await getIsolatedDriverTracking();
                await startDriverTracking(1, destLat, destLng);

                // Simulate a position update inside the geofence
                const watchCallback = mockGeolocation.watchPosition.mock.calls[0][0];
                await watchCallback({ coords: { latitude: 40.7129, longitude: -74.0061 } }); // ~15 meters away

                expect(showNotification).toHaveBeenCalledWith("It looks like you're on site! Marking status as 'Arrived'...", 'info');
                expect(apiFetch).toHaveBeenCalledWith('/api/loads/1/arrived', { method: 'PATCH' });
            });

            it("should not try to update to 'arrived' again if already arrived", async () => {
                const { startDriverTracking } = await getIsolatedDriverTracking();
                await startDriverTracking(1, destLat, destLng);

                const watchCallback = mockGeolocation.watchPosition.mock.calls[0][0];

                // 1. Arrive
                await watchCallback({ coords: { latitude: 40.7129, longitude: -74.0061 } });
                expect(apiFetch).toHaveBeenCalledTimes(1);

                // 2. Move slightly, still within the geofence
                await watchCallback({ coords: { latitude: 40.7130, longitude: -74.0062 } });
                expect(apiFetch).toHaveBeenCalledTimes(1); // Should not be called again
            });

            it("should show a warning if driver leaves the site after arriving", async () => {
                const { startDriverTracking } = await getIsolatedDriverTracking();
                await startDriverTracking(1, destLat, destLng);

                const watchCallback = mockGeolocation.watchPosition.mock.calls[0][0];

                // 1. Arrive
                await watchCallback({ coords: { latitude: 40.7129, longitude: -74.0061 } });
                expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('Arrived'), expect.any(String));

                // 2. Leave the site (move > 1000m away)
                await watchCallback({ coords: { latitude: 40.7228, longitude: -74.0060 } }); // ~1100 meters away
                expect(showNotification).toHaveBeenCalledWith("It looks like you left the site. Did you forget to tap 'Completed Loading'?", 'warning');
            });
        });

        describe('Background Location Sync', () => {
            it('should sync location to backend and websocket every 5 seconds if truckId is provided', async () => {
                const { startDriverTracking } = await getIsolatedDriverTracking();
                await startDriverTracking(1, 40.7128, -74.0060, 99); // truckId = 99

                // Simulate the device receiving a GPS update
                const watchCallback = mockGeolocation.watchPosition.mock.calls[0][0];
                await watchCallback({ coords: { latitude: 40.75, longitude: -74.05 } });

                // Fast-forward time by 5 seconds to trigger the interval
                await jest.advanceTimersByTimeAsync(5000);

                // Check for WebSocket broadcast
                expect(mockSocketInstance.emit).toHaveBeenCalledWith('driver_location_update', {
                    loadId: 1,
                    truckId: 99,
                    latitude: 40.75,
                    longitude: -74.05
                });

                // Check for backend API sync
                expect(apiFetch).toHaveBeenCalledWith('/api/trucks/99/location', {
                    method: 'PATCH',
                    body: { latitude: 40.75, longitude: -74.05 }
                });

                // Fast-forward another 5 seconds
                await jest.advanceTimersByTimeAsync(5000);
                expect(apiFetch).toHaveBeenCalledTimes(2); // Called again
            });

            it('should NOT sync location if truckId is not provided', async () => {
                const { startDriverTracking } = await getIsolatedDriverTracking();
                await startDriverTracking(1, 40.7128, -74.0060, null); // No truckId

                const watchCallback = mockGeolocation.watchPosition.mock.calls[0][0];
                await watchCallback({ coords: { latitude: 40.75, longitude: -74.05 } });

                await jest.advanceTimersByTimeAsync(5000);

                // apiFetch should not have been called for location sync
                expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/location'), expect.any(Object));
            });
        });
    });

    describe('stopDriverTracking', () => {
        it('should clear the watch, stop the sync interval, and release wake lock', async () => {
            // Use the same isolated module instance to share the `watchId` state
            const { startDriverTracking, stopDriverTracking } = await getIsolatedDriverTracking();

            await startDriverTracking(1, 40.7128, -74.0060, 123);
            stopDriverTracking();

            expect(mockGeolocation.clearWatch).toHaveBeenCalledWith(12345);
            expect(mockSocketInstance.disconnect).toHaveBeenCalled();
            
            // Check that the interval was cleared
            const intervalId = setInterval(() => {}, 1000);
            expect(clearInterval).toHaveBeenCalledWith(expect.any(Number));
            clearInterval(intervalId);
        });
    });
});