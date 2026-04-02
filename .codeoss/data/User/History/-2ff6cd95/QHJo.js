/**
 * @jest-environment jsdom
 */


// 1. Mock the imported notification utility
jest.mock('./notifications.js', () => ({
    showNotification: jest.fn(),
}));
const { showNotification } = require('./notifications.js');

// 2. Create a comprehensive mock of the Mapbox GL JS library
const mockMapInstance = {
    addControl: jest.fn(),
    on: jest.fn(),
    remove: jest.fn(),
    getSource: jest.fn(),
    addSource: jest.fn(),
    addLayer: jest.fn(),
    fitBounds: jest.fn(),
    flyTo: jest.fn(),
    getSource: jest.fn().mockReturnValue(undefined), // Default to source not existing
};

const mockMarkerInstance = {
    setLngLat: jest.fn().mockReturnThis(),
    setPopup: jest.fn().mockReturnThis(),
    addTo: jest.fn().mockReturnThis(),
    remove: jest.fn(),
    getLngLat: jest.fn().mockReturnValue({ lng: -74, lat: 40 }),
    getPopup: jest.fn().mockReturnThis(),
    togglePopup: jest.fn(),
    isOpen: jest.fn().mockReturnValue(false),
};

const mockPopupInstance = {
    setHTML: jest.fn().mockReturnThis(),
};

const mockLngLatBoundsInstance = {
    extend: jest.fn(),
};

const mockMapbox = {
    Map: jest.fn(() => mockMapInstance),
    Marker: jest.fn(() => mockMarkerInstance),
    Popup: jest.fn(() => mockPopupInstance),
    NavigationControl: jest.fn(),
    LngLatBounds: jest.fn(() => mockLngLatBoundsInstance),
};


describe('Mapbox Maps Logic (mapbox_maps.js)', () => {
    let mapboxModule;
    let showNotification;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        
        document.body.innerHTML = `
            <meta name="mapbox-token" content="test-token">
            <div id="map" class="map-container" data-lng="-98" data-lat="39" data-zoom="4" data-marker="true"></div>
        `;
        
        // Assign the mock to the global window object, which is where the script expects to find it
        window.mapboxgl = mockMapbox;
        showNotification = require('./notifications.js').showNotification;

        // Re-require the module to get a fresh state for each test
        mapboxModule = require('./mapbox_maps');
    });

    describe('initializeAllMaps', () => {
        it('should initialize all map containers found on the page', () => {
            mapboxModule.initializeAllMaps();
            expect(mockMapbox.Map).toHaveBeenCalledTimes(1);
        });

        it('should read data attributes for map configuration', () => {
            mapboxModule.initializeAllMaps();
            const firstMapConfig = mockMapbox.Map.mock.calls[0][0];
            expect(firstMapConfig.center).toEqual([-98, 39]);
            expect(firstMapConfig.zoom).toBe(4);
        });

        it('should add a marker if data-marker is true', () => {
            mapboxModule.initializeAllMaps();
            // The first map has data-marker="true", the second does not.
            expect(mockMapbox.Marker).toHaveBeenCalledTimes(1);
            expect(mockMarkerInstance.addTo).toHaveBeenCalledWith(mockMapInstance);
        });

        it('should show an error if the Mapbox token is missing', () => {
            document.querySelector('meta[name="mapbox-token"]').remove();
            mapboxModule.initializeAllMaps();
            expect(showNotification).toHaveBeenCalledWith('Map configuration is missing.', 'error');
            expect(mockMapbox.Map).not.toHaveBeenCalled();
        });

        it('should show an error if the mapboxgl library is not loaded', () => {
            window.mapboxgl = undefined;
            mapboxModule.initializeAllMaps();
            expect(showNotification).toHaveBeenCalledWith('Failed to load interactive maps.', 'error');
        });
    });

    describe('updateMapMarkers', () => {
        it('should create markers and popups for a list of locations', () => {
            const locations = [
                { type: 'load', title: 'Test Load', lng: -74, lat: 40 },
                { type: 'company', name: 'Test Company', lng: -118, lat: 34, is_suspended: true },
            ];
            
            mapboxModule.initializeAllMaps(); // To populate `activeMaps`
            mapboxModule.updateMapMarkers(locations);

            expect(mockMapbox.Marker).toHaveBeenCalledTimes(3); // 1 from init, 2 from update
            expect(mockPopupInstance.setHTML).toHaveBeenCalledTimes(2);
            
            // Check popup content for the load
            expect(mockPopupInstance.setHTML.mock.calls[0][0]).toContain('Load: Test Load');
            // Check popup content for the company
            expect(mockPopupInstance.setHTML.mock.calls[1][0]).toContain('Test Company');
            expect(mockPopupInstance.setHTML.mock.calls[1][0]).toContain('This company is currently suspended.');
        });

        it('should clear old markers before adding new ones', () => {
            mapboxModule.initializeAllMaps();
            
            // First search
            mapboxModule.updateMapMarkers([{ type: 'load', lng: -74, lat: 40 }]);
            expect(mockMarkerInstance.remove).toHaveBeenCalledTimes(1); // The initial marker from initializeAllMaps is removed
            
            // Second search
            mapboxModule.updateMapMarkers([{ type: 'company', lng: -118, lat: 34 }]);
            expect(mockMarkerInstance.remove).toHaveBeenCalledTimes(2); // The marker from the first search is removed
        });

        it('should apply a grayscale filter to unavailable/suspended markers', () => {
            const locations = [{ type: 'company', name: 'Suspended Co', lng: -118, lat: 34, is_suspended: true }];
            
            mapboxModule.initializeAllMaps();
            mapboxModule.updateMapMarkers(locations);

            // The _createCustomMarkerElement function sets the style directly. We check the second call because the first is the initial map marker.
            const createdMarkerElement = mockMapbox.Marker.mock.calls[1][0];
            expect(createdMarkerElement.style.filter).toBe('grayscale(100%)');
            expect(createdMarkerElement.style.opacity).toBe('0.6');
        });

        it('should fit the map bounds to the new markers', () => {
            const locations = [
                { type: 'load', lng: -74, lat: 40 },
                { type: 'company', lng: -118, lat: 34 },
            ];
            
            mapboxModule.initializeAllMaps();
            mapboxModule.updateMapMarkers(locations);

            expect(mockLngLatBoundsInstance.extend).toHaveBeenCalledTimes(2); // Called for each location
            expect(mockMapInstance.fitBounds).toHaveBeenCalledTimes(1); // Called once per update
        });
    });

    describe('drawRoute and clearRoute', () => {
        const mockGeoJSON = { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[-74, 40], [-75, 41]] } };

        it('should add a new source and layer if none exists', () => {
            mapboxModule.initializeAllMaps();
            mapboxModule.drawRoute(mockGeoJSON);

            expect(mockMapInstance.addSource).toHaveBeenCalledWith('driver-route-source', expect.any(Object));
            expect(mockMapInstance.addLayer).toHaveBeenCalledWith(expect.any(Object), 'waterway-label');
        });

        it('should update an existing source if called again', () => {
            const mockSource = { setData: jest.fn() };
            mockMapInstance.getSource.mockReturnValue(mockSource);

            mapboxModule.initializeAllMaps();
            mapboxModule.drawRoute(mockGeoJSON);

            expect(mockMapInstance.addSource).not.toHaveBeenCalled();
            expect(mockSource.setData).toHaveBeenCalledWith(mockGeoJSON);
        });

        it('should clear the route data from the source', () => {
            const mockSource = { setData: jest.fn() };
            mockMapInstance.getSource.mockReturnValue(mockSource);

            mapboxModule.initializeAllMaps();
            mapboxModule.clearRoute();

            expect(mockSource.setData).toHaveBeenCalledWith({ "type": "FeatureCollection", "features": [] });
        });
    });

    describe('focusMapMarker', () => {
        it('should fly to the coordinates and toggle the correct popup', () => {
            mapboxModule.initializeAllMaps();
            mapboxModule.updateMapMarkers([{ type: 'load', lng: -74, lat: 40, name: 'Test Load' }]);

            mapboxModule.focusMapMarker(-74, 40);

            expect(mockMapInstance.flyTo).toHaveBeenCalledWith({ center: [-74, 40], zoom: 15, essential: true });
            expect(mockMarkerInstance.togglePopup).toHaveBeenCalledTimes(1); // Only the matching marker's popup is toggled
        });
    });
});