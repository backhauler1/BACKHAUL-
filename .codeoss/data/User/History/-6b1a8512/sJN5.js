/*
    Reusable Mapbox map generation script.
    - It geocodes start and end locations.
    - It fetches and displays a driving route.
    - It adds markers for the start and end points.
    - It handles errors gracefully.

    Usage:
    1. Include Mapbox GL JS and this script in your HTML.
    2. Set `mapboxgl.accessToken` in a <script> tag before including this file.
    3. On DOMContentLoaded, call `initializeMaps(options)` with the correct parameters for your page.
*/

async function geocode(place) {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(place)}.json?access_token=${mapboxgl.accessToken}&limit=1`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.features && data.features.length > 0) {
        return data.features[0].center; // [longitude, latitude]
    }
    return null;
}

async function getRoute(start, end) {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${start[0]},${start[1]};${end[0]},${end[1]}?geometries=geojson&access_token=${mapboxgl.accessToken}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.routes && data.routes.length > 0) {
        return data.routes[0].geometry;
    }
    return null;
}

async function initializeMaps(options) {
    const { cardSelector, startLocationAttr, endLocationAttr, idAttr, idPrefix } = options;

    const cards = document.querySelectorAll(cardSelector);

    cards.forEach(async (card) => {
        const startLocation = card.dataset[startLocationAttr];
        const endLocation = card.dataset[endLocationAttr];
        const itemId = card.dataset[idAttr];
        const mapContainerId = `${idPrefix}-${itemId}`;

        if (!startLocation || !endLocation) return;

        try {
            const [startCoords, endCoords] = await Promise.all([
                geocode(startLocation),
                geocode(endLocation)
            ]);

            if (!startCoords || !endCoords) {
                console.error(`Could not geocode one or both locations for item ${itemId}: ${startLocation}, ${endLocation}`);
                document.getElementById(mapContainerId).innerHTML = '<p style="text-align:center; padding-top: 80px; color: #888;">Could not display map.</p>';
                return;
            }

            const routeGeoJSON = await getRoute(startCoords, endCoords);

            const map = new mapboxgl.Map({
                container: mapContainerId,
                style: 'mapbox://styles/mapbox/streets-v11',
                center: startCoords,
                zoom: 4,
                interactive: false // Make map non-interactive for a cleaner list view
            });

            map.on('load', () => {
                new mapboxgl.Marker({ color: '#32CD32' }).setLngLat(startCoords).addTo(map);
                new mapboxgl.Marker({ color: '#FF4500' }).setLngLat(endCoords).addTo(map);

                if (routeGeoJSON) {
                    const routeId = `route-${itemId}`;
                    map.addSource(routeId, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: routeGeoJSON } });
                    map.addLayer({ id: routeId, type: 'line', source: routeId, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3887be', 'line-width': 5, 'line-opacity': 0.75 } });
                    const bounds = new mapboxgl.LngLatBounds(startCoords, endCoords);
                    map.fitBounds(bounds, { padding: 50 });
                }
            });
        } catch (error) {
            console.error(`Error creating map for item ${itemId}:`, error);
            document.getElementById(mapContainerId).innerHTML = '<p style="text-align:center; padding-top: 80px; color: #888;">Error loading map.</p>';
        }
    });
}