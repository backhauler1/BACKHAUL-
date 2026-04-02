/**
 * @jest-environment jsdom
 */

import { initializeAllMaps, updateMapMarkers, drawRoute, clearRoute, focusMapMarker } from './mapbox_maps';
import { showNotification } from './notifications';

// 1. Mock the imported notification utility
jest.mock('./notifications', () => ({
    showNotification: jest.fn(),
}));

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
    beforeEach(() => {
        jest.clearAllMocks();
        
        // 3. Set up the dummy DOM and global mapboxgl object before each test
        document.body.innerHTML = `
            <meta name="mapbox-token" content="test-token">
            <div class="map-container" data-lng="-98" data-lat="39" data-zoom="4" data-marker="true"></div>
            <div id="another-map" class="map-container"></div>
        `;
        
        // Assign the mock to the global window object, which is where the script expects to find it
        window.mapboxgl = mockMapbox;
    });

    describe('initializeAllMaps', () => {
        it('should initialize all map containers found on the page', () => {
            initializeAllMaps();
            expect(mockMapbox.Map).toHaveBeenCalledTimes(2);
        });

        it('should read data attributes for map configuration', () => {
            initializeAllMaps();
            const firstMapConfig = mockMapbox.Map.mock.calls[0][0];
            expect(firstMapConfig.center).toEqual([-98, 39]);
            expect(firstMapConfig.zoom).toBe(4);
        });

        it('should add a marker if data-marker is true', () => {
            initializeAllMaps();
            // The first map has data-marker="true", the second does not.
            expect(mockMapbox.Marker).toHaveBeenCalledTimes(1);
            expect(mockMarkerInstance.addTo).toHaveBeenCalledWith(mockMapInstance);
        });

        it('should show an error if the Mapbox token is missing', () => {
            document.querySelector('meta[name="mapbox-token"]').remove();
            initializeAllMaps();
            expect(showNotification).toHaveBeenCalledWith('Map configuration is missing.', 'error');
            expect(mockMapbox.Map).not.toHaveBeenCalled();
        });

        it('should show an error if the mapboxgl library is not loaded', () => {
            window.mapboxgl = undefined;
            initializeAllMaps();
            expect(showNotification).toHaveBeenCalledWith('Failed to load interactive maps.', 'error');
        });
    });

    describe('updateMapMarkers', () => {
        it('should create markers and popups for a list of locations', () => {
            const locations = [
                { type: 'load', title: 'Test Load', lng: -74, lat: 40 },
                { type: 'company', name: 'Test Company', lng: -118, lat: 34, is_suspended: true },
            ];
            
            initializeAllMaps(); // To populate `activeMaps`
            updateMapMarkers(locations);

            expect(mockMapbox.Marker).toHaveBeenCalledTimes(2);
            expect(mockPopupInstance.setHTML).toHaveBeenCalledTimes(2);
            
            // Check popup content for the load
            expect(mockPopupInstance.setHTML.mock.calls[0][0]).toContain('Load: Test Load');
            // Check popup content for the company
            expect(mockPopupInstance.setHTML.mock.calls[1][0]).toContain('Test Company');
            expect(mockPopupInstance.setHTML.mock.calls[1][0]).toContain('This company is currently suspended.');
        });

        it('should clear old markers before adding new ones', () => {
            initializeAllMaps();
            
            // First search
            updateMapMarkers([{ type: 'load', lng: -74, lat: 40 }]);
            expect(mockMarkerInstance.remove).not.toHaveBeenCalled();
            
            // Second search
            updateMapMarkers([{ type: 'company', lng: -118, lat: 34 }]);
            expect(mockMarkerInstance.remove).toHaveBeenCalledTimes(1);
        });

        it('should apply a grayscale filter to unavailable/suspended markers', () => {
            const locations = [{ type: 'company', name: 'Suspended Co', lng: -118, lat: 34, is_suspended: true }];
            
            initializeAllMaps();
            updateMapMarkers(locations);

            // The _createCustomMarkerElement function sets the style directly
            const createdMarkerElement = mockMapbox.Marker.mock.calls[0][0];
            expect(createdMarkerElement.style.filter).toBe('grayscale(100%)');
            expect(createdMarkerElement.style.opacity).toBe('0.6');
        });

        it('should fit the map bounds to the new markers', () => {
            const locations = [
                { type: 'load', lng: -74, lat: 40 },
                { type: 'company', lng: -118, lat: 34 },
            ];
            
            initializeAllMaps();
            updateMapMarkers(locations);

            expect(mockLngLatBoundsInstance.extend).toHaveBeenCalledTimes(2);
            expect(mockMapInstance.fitBounds).toHaveBeenCalledTimes(1);
        });
    });

    describe('drawRoute and clearRoute', () => {
        const mockGeoJSON = { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[-74, 40], [-75, 41]] } };

        it('should add a new source and layer if none exists', () => {
            initializeAllMaps();
            drawRoute(mockGeoJSON);

            expect(mockMapInstance.addSource).toHaveBeenCalledWith('driver-route-source', expect.any(Object));
            expect(mockMapInstance.addLayer).toHaveBeenCalledWith(expect.any(Object), 'waterway-label');
        });

        it('should update an existing source if called again', () => {
            const mockSource = { setData: jest.fn() };
            mockMapInstance.getSource.mockReturnValue(mockSource);

            initializeAllMaps();
            drawRoute(mockGeoJSON);

            expect(mockMapInstance.addSource).not.toHaveBeenCalled();
            expect(mockSource.setData).toHaveBeenCalledWith(mockGeoJSON);
        });

        it('should clear the route data from the source', () => {
            const mockSource = { setData: jest.fn() };
            mockMapInstance.getSource.mockReturnValue(mockSource);

            initializeAllMaps();
            clearRoute();

            expect(mockSource.setData).toHaveBeenCalledWith({ "type": "FeatureCollection", "features": [] });
        });
    });

    describe('focusMapMarker', () => {
        it('should fly to the coordinates and toggle the correct popup', () => {
            initializeAllMaps();
            updateMapMarkers([{ type: 'load', lng: -74, lat: 40 }]);

            focusMapMarker(-74, 40);

            expect(mockMapInstance.flyTo).toHaveBeenCalledWith({ center: [-74, 40], zoom: 15, essential: true });
            expect(mockMarkerInstance.togglePopup).toHaveBeenCalledTimes(1);
        });
    });
});