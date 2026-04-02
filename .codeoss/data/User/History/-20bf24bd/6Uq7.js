import { showNotification } from './notifications.js';

// Store map instances and search markers so we can update/clear them later
const activeMaps = [];
let currentSearchMarkers = [];

/**
 * Initializes all map containers on the page using Mapbox GL JS.
 */
export function initializeAllMaps() {
    const mapContainers = document.querySelectorAll('.map-container');
    if (mapContainers.length === 0) return;

    // Check if Mapbox is loaded globally (e.g., via CDN in the HTML)
    if (typeof mapboxgl === 'undefined') {
        console.error('Mapbox GL JS is not loaded. Please include it in your HTML.');
        showNotification('Failed to load interactive maps.', 'error');
        return;
    }

    // IMPORTANT: Your backend must provide the Mapbox access token.
    // A good practice is to render it into a meta tag in your HTML <head>:
    // <meta name="mapbox-token" content="YOUR_REAL_TOKEN">
    const token = document.querySelector('meta[name="mapbox-token"]')?.content;
    if (!token) {
        console.error('Mapbox access token is missing. Please provide it in a <meta name="mapbox-token"> tag.');
        showNotification('Map configuration is missing.', 'error');
        return;
    }
    mapboxgl.accessToken = token;

    mapContainers.forEach(container => {
        _initializeMap(container);
    });
}

/**
 * Sets up an individual Mapbox map instance.
 * @param {HTMLElement} container The DOM element to render the map into.
 * @private
 */
function _initializeMap(container) {
    // Read configuration from data attributes, falling back to defaults (e.g., center of the US)
    const lng = parseFloat(container.dataset.lng) || -98.5795;
    const lat = parseFloat(container.dataset.lat) || 39.8283;
    const zoom = parseFloat(container.dataset.zoom) || 4;

    try {
        const map = new mapboxgl.Map({
            container: container,
            style: 'mapbox://styles/mapbox/streets-v12', // Standard Mapbox style
            center: [lng, lat],
            zoom: zoom
        });

        // Add basic navigation controls (zoom in/out, rotation)
        map.addControl(new mapboxgl.NavigationControl());

        // Add a marker if the data attributes specify it
        if (container.dataset.marker === 'true') {
            const markerEl = _createCustomMarkerElement();
            new mapboxgl.Marker(markerEl)
                .setLngLat([lng, lat])
                .addTo(map);
        }

        // Store the map instance for future updates (like adding search results)
        activeMaps.push(map);
    } catch (error) {
        console.error('Error initializing Mapbox instance:', error);
        showNotification('An error occurred while rendering the map.', 'error');
    }
}

/**
 * Clears old search markers and adds new ones to all active map instances.
 * @param {Array<Object>} locations - Array of location objects from the API.
 * @param {Object} [options] - Configuration options.
 * @param {boolean} [options.clear=true] - Whether to clear existing markers before adding new ones.
 */
export function updateMapMarkers(locations, options = {}) {
    const { clear = true } = options;

    // Clear existing markers from previous searches
    if (clear) {
        currentSearchMarkers.forEach(marker => marker.remove());
        currentSearchMarkers = [];
    }

    if (!locations || locations.length === 0) return;

    activeMaps.forEach(map => {
        const currentUserId = document.body.dataset.userId; // Get current user's ID from body data attribute

        locations.forEach(loc => {
            if (loc.lng !== undefined && loc.lat !== undefined) {
                // Build the HTML content for the popup.
                // NOTE: This assumes your API response for each location includes `name`, `description`, `ownerId`, and `isAvailable`.
                let chatButtonHTML = '';
                // Show chat button only if user is logged in, it's not their own truck, AND the truck is available.
                if (currentUserId && loc.ownerId && currentUserId !== String(loc.ownerId) && loc.isAvailable !== false) {
                    // This URL structure assumes your server can handle a route like `/chat?with=USER_ID`
                    // to render the correct chat page.
                    const chatUrl = `/chat?with=${loc.ownerId}`;
                chatButtonHTML = `<a href="${chatUrl}" class="popup-chat-btn" style="display: inline-block; margin-top: 10px; padding: 5px 10px; background-color: #6c757d; color: white; text-decoration: none; border-radius: 4px; margin-right: 5px;">Chat</a>`;
                }

                const availabilityStatusHTML = loc.isAvailable === false
                    ? '<p style="margin: 5px 0; font-weight: bold; color: #d9534f;">Currently Unavailable</p>'
                    : '';

            let popupHTML = '';
            if (loc.type === 'load') {
                const requestLoadUrl = `/request-load/${loc.id}`;
                const requestButtonHTML = `<a href="${requestLoadUrl}" class="popup-request-btn" style="display: inline-block; margin-top: 10px; padding: 5px 10px; background-color: #28a745; color: white; text-decoration: none; border-radius: 4px;">Request Load</a>`;
                const distanceInfo = loc.distance ? `<span style="font-weight: normal; font-size: 0.9em;"> (${loc.distance.toFixed(1)} mi to pickup)</span>` : '';
                popupHTML = `
                    <div class="truck-popup" style="color: #333;">
                        <h4 style="margin: 0 0 5px 0;">Load: ${loc.title || 'Untitled Load'}</h4>
                        <div style="margin: 5px 0; font-size: 0.9em;">
                            <p style="margin: 0;"><strong>From:</strong> ${loc.pickupAddress || 'Not specified'}${distanceInfo}</p>
                            <p style="margin: 0;"><strong>To:</strong> ${loc.deliveryAddress || 'Not specified'}</p>
                        </div>
                        <p style="margin: 5px 0; font-size: 0.85em; color: #666;"><strong>Requires:</strong> ${loc.requiredVehicleClass || 'Any Vehicle'}</p>
                        ${availabilityStatusHTML}
                        <p style="margin: 5px 0; font-size: 0.9em;">${loc.description || 'Details unavailable.'}</p>
                        ${requestButtonHTML}
                    </div>
                `;
            } else {
                const requestDriverUrl = `/request-driver/${loc.ownerId || loc.id}`;
                const requestButtonHTML = `<a href="${requestDriverUrl}" class="popup-request-btn" style="display: inline-block; margin-top: 10px; padding: 5px 10px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px;">Request Driver</a>`;
                popupHTML = `
                    <div class="truck-popup" style="color: #333;">
                        <h4 style="margin: 0 0 5px 0;">${loc.name || 'Food Truck'}</h4>
                        <p style="margin: 0 0 5px 0; font-size: 0.85em; color: #666;"><strong>Type:</strong> ${loc.vehicleClass || 'Not specified'}</p>
                        ${availabilityStatusHTML}
                        <p style="margin: 0 0 5px 0; font-size: 0.9em;">${loc.description || 'Details unavailable.'}</p>
                        <div>${chatButtonHTML} ${requestButtonHTML}</div>
                    </div>
                `;
            }

                const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(popupHTML);

                const markerEl = _createCustomMarkerElement(loc);
                const marker = new mapboxgl.Marker(markerEl).setLngLat([loc.lng, loc.lat]).setPopup(popup).addTo(map);
                currentSearchMarkers.push(marker);
            }
        });

        // Adjust the map viewport to fit all current search markers
        const bounds = new mapboxgl.LngLatBounds();
        let hasValidLocation = false;
        currentSearchMarkers.forEach(marker => {
            bounds.extend(marker.getLngLat());
            hasValidLocation = true;
        });

        if (hasValidLocation) {
            map.fitBounds(bounds, {
                padding: 50, // Add some padding around the edges
                maxZoom: 15, // Prevent zooming in too close if there's only one result
                duration: 1000 // Smooth fly-to animation in ms
            });
        }
    });
}

/**
 * Draws a GeoJSON route line on the map.
 * @param {Object} geoJSON - The route geometry in GeoJSON format.
 */
export function drawRoute(geoJSON) {
    if (!geoJSON) return;

    activeMaps.forEach(map => {
        const sourceId = 'driver-route-source';
        const layerId = 'driver-route-layer';

        if (map.getSource(sourceId)) {
            map.getSource(sourceId).setData(geoJSON);
        } else {
            map.addSource(sourceId, {
                'type': 'geojson',
                'data': geoJSON
            });
            map.addLayer({
                'id': layerId,
                'type': 'line',
                'source': sourceId,
                'layout': {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                'paint': {
                    'line-color': '#007bff', // A nice blue route line
                    'line-width': 6,
                    'line-opacity': 0.6
                }
            }, 'waterway-label'); // Insert beneath labels if possible so road names stay visible
        }
    });
}

/**
 * Clears the currently drawn route from the map.
 */
export function clearRoute() {
    activeMaps.forEach(map => {
        const sourceId = 'driver-route-source';
        if (map.getSource(sourceId)) {
            map.getSource(sourceId).setData({
                "type": "FeatureCollection",
                "features": []
            });
        }
    });
}

/**
 * Creates a custom DOM element to serve as the map marker.
 * @param {Object} [location={}] - The location data, used to determine availability.
 * @returns {HTMLElement}
 * @private
 */
function _createCustomMarkerElement(location = {}) {
    const el = document.createElement('div');
    el.className = 'custom-truck-marker';
    // TODO: Replace with the actual URL/path to your custom marker image
    el.style.backgroundImage = 'url("https://cdn-icons-png.flaticon.com/512/1046/1046853.png")';
    el.style.width = '32px';
    el.style.height = '32px';
    el.style.backgroundSize = 'contain';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.cursor = 'pointer';

    // If the truck is unavailable, apply a different style (e.g., grayscale and lower opacity).
    if (location.isAvailable === false) {
        el.style.filter = 'grayscale(100%)';
        el.style.opacity = '0.6';
    }

    return el;
}

/**
 * Pans the map to a specific location and opens its popup.
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 */
export function focusMapMarker(lng, lat) {
    if (activeMaps.length === 0) return;

    activeMaps.forEach(map => {
        // Pan to the location smoothly
        map.flyTo({
            center: [lng, lat],
            zoom: 15,
            essential: true 
        });

        // Find the corresponding marker and open its popup
        const targetMarker = currentSearchMarkers.find(marker => {
            const markerLngLat = marker.getLngLat();
            return markerLngLat.lng === lng && markerLngLat.lat === lat;
        });

        if (targetMarker) {
            const popup = targetMarker.getPopup();
            if (popup && !popup.isOpen()) {
                targetMarker.togglePopup();
            }
        }
    });
}