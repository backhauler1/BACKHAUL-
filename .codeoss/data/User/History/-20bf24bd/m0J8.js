import { showNotification } from './notifications.js';

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

    // TODO: Replace with your actual Mapbox access token.
    // It's often best practice to inject this via a meta tag or a global window object from your backend.
    mapboxgl.accessToken = 'YOUR_MAPBOX_ACCESS_TOKEN';

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
            new mapboxgl.Marker()
                .setLngLat([lng, lat])
                .addTo(map);
        }
    } catch (error) {
        console.error('Error initializing Mapbox instance:', error);
        showNotification('An error occurred while rendering the map.', 'error');
    }
}