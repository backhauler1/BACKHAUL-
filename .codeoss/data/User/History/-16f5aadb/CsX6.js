import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

let watchId = null;
let locationUpdateInterval = null;
let lastKnownPosition = null;
let wakeLock = null;
let currentStatus = 'en_route'; // Can be 'en_route', 'arrived', 'loading_completed'

/**
 * Calculates the distance between two coordinates in meters using the Haversine formula.
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Starts passively tracking the driver's location relative to the pickup destination.
 * Also continuously syncs the live location to the backend and prevents the screen from sleeping.
 */
export async function startDriverTracking(loadId, destLat, destLng, truckId) {
    if (!navigator.geolocation) {
        console.warn('Geolocation is not supported by your browser.');
        return;
    }

    // Request a Wake Lock to prevent the screen from turning off while driving.
    // Mobile browsers suspend background geolocation tracking when the screen turns off!
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (err) {
        console.error('Could not request wake lock:', err);
    }

    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
    }
    if (locationUpdateInterval) {
        clearInterval(locationUpdateInterval);
    }

    watchId = navigator.geolocation.watchPosition(
        async (position) => {
            const { latitude, longitude } = position.coords;
            lastKnownPosition = { latitude, longitude };

            const distanceInMeters = calculateDistance(latitude, longitude, destLat, destLng);

            // Geofence: Arrival (Less than 500 meters from pickup)
            if (currentStatus === 'en_route' && distanceInMeters < 500) {
                currentStatus = 'arrived';
                showNotification("It looks like you're on site! Marking status as 'Arrived'...", 'info');
                
                try {
                    await apiFetch(`/api/loads/${loadId}/arrived`, { method: 'PATCH' });
                    showNotification('Status updated to Arrived.', 'success');
                    
                    // Optional: Disable manual arrival button in your UI
                    const arrivedBtn = document.getElementById(`btn-arrived-${loadId}`);
                    if (arrivedBtn) arrivedBtn.disabled = true;
                } catch (err) {
                    console.error('Failed to auto-update arrival:', err);
                }
            }

            // Geofence: Departure (Was arrived, but now > 1,000 meters away)
            if (currentStatus === 'arrived' && distanceInMeters > 1000) {
                // We prompt them to mark it manually instead of auto-completing to prevent accidental triggers
                showNotification("It looks like you left the site. Did you forget to tap 'Completed Loading'?", 'warning');
            }
        },
        (error) => {
            console.error('Error watching driver position:', error);
        },
        {
            enableHighAccuracy: true, // Requires device GPS
            maximumAge: 10000,
            timeout: 10000
        }
    );

    // Sync location to the backend every 30 seconds
    if (truckId) {
        locationUpdateInterval = setInterval(async () => {
            if (lastKnownPosition) {
                try {
                    await apiFetch(`/api/trucks/${truckId}/location`, {
                        method: 'PATCH',
                        body: lastKnownPosition
                    });
                } catch (err) {
                    console.error('Failed to sync live location:', err);
                }
            }
        }, 30000);
    }
}

/**
 * Stops tracking the driver's location.
 */
export function stopDriverTracking() {
    if (watchId && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (locationUpdateInterval) {
        clearInterval(locationUpdateInterval);
        locationUpdateInterval = null;
    }
    if (wakeLock !== null) {
        wakeLock.release().catch(console.error);
        wakeLock = null;
    }
    lastKnownPosition = null;
}