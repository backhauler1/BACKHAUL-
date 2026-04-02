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

        // Store the map instance for future updates (like adding search results)
        activeMaps.push(map);
    } catch (error) {
        console.error('Error initializing Mapbox instance:', error);
        showNotification('An error occurred while rendering the map.', 'error');
    }
}

/**
 * Clears old search markers and adds new ones to all active map instances.
 * @param {Array<{lng: number, lat: number}>} locations - Array of location objects.
 */
export function updateMapMarkers(locations) {
    // Clear existing markers from previous searches
    currentSearchMarkers.forEach(marker => marker.remove());
    currentSearchMarkers = [];

    if (!locations || locations.length === 0) return;

    activeMaps.forEach(map => {
        const bounds = new mapboxgl.LngLatBounds();
        let hasValidLocation = false;

        locations.forEach(loc => {
            if (loc.lng !== undefined && loc.lat !== undefined) {
                // Build the HTML content for the popup. 
                // Note: Adjust 'loc.name' and 'loc.description' based on your actual API response structure.
                const popupHTML = `
                    <div class="truck-popup" style="color: #333;">
                        <h4 style="margin: 0 0 5px 0;">${loc.name || 'Food Truck'}</h4>
                        <p style="margin: 0; font-size: 0.9em;">${loc.description || 'Details unavailable.'}</p>
                    </div>
                `;
                const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(popupHTML);

                const marker = new mapboxgl.Marker().setLngLat([loc.lng, loc.lat]).setPopup(popup).addTo(map);
                
                currentSearchMarkers.push(marker);
                bounds.extend([loc.lng, loc.lat]);
                hasValidLocation = true;
            }
        });

        // Adjust the map viewport to fit all the extended bounds
        if (hasValidLocation) {
            map.fitBounds(bounds, {
                padding: 50, // Add some padding around the edges
                maxZoom: 15, // Prevent zooming in too close if there's only one result
                duration: 1000 // Smooth fly-to animation in ms
            });
        }
    });
}