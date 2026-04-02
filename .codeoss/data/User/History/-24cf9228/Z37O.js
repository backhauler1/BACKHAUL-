/**
 * @jest-environment jsdom
 */

import { renderResultsList } from './results_view';
import { focusMapMarker } from './mapbox_maps';

jest.mock('./mapbox_maps', () => ({
jest.mock('./mapbox_maps.js', () => ({
    focusMapMarker: jest.fn(),
}));

describe('Results View UI (results_view.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Setup the expected container in the DOM
        document.body.innerHTML = `<div id="results-list-container"></div>`;
        // Suppress expected console warnings
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('should clear the container and do nothing if results are empty', () => {
        const container = document.getElementById('results-list-container');
        container.innerHTML = '<div class="old-item"></div>';
        
        renderResultsList([]);
        
        expect(container.innerHTML).toBe('');
    });

    it('should correctly render a company result and handle map focus on click', () => {
        const mockCompany = { type: 'company', name: 'Test Transit', description: 'Fast shipping', services: ['LTL', 'FTL'], lng: -74, lat: 40 };
        
        renderResultsList([mockCompany]);
        
        const container = document.getElementById('results-list-container');
        expect(container.innerHTML).toContain('Test Transit');
        expect(container.innerHTML).toContain('LTL, FTL');
        
        // Test click interaction
        const itemElement = container.querySelector('.result-item--company');
        expect(itemElement).not.toBeNull();
        
        itemElement.click();
        
        expect(focusMapMarker).toHaveBeenCalledWith(-74, 40);
        expect(itemElement.classList.contains('active')).toBe(true);
    });

    it('should correctly render a load result and handle map focus on click', () => {
        const mockLoad = { type: 'load', title: 'Heavy Machinery', pickupAddress: 'Chicago, IL', deliveryAddress: 'Detroit, MI', lng: -87, lat: 41 };
        
        renderResultsList([mockLoad]);
        
        const container = document.getElementById('results-list-container');
        expect(container.innerHTML).toContain('Load: Heavy Machinery');
        expect(container.innerHTML).toContain('Chicago, IL');
        
        const itemElement = container.querySelector('.result-item--load');
        itemElement.click();
        
        expect(focusMapMarker).toHaveBeenCalledWith(-87, 41);
    });

    it('should render a truck result and apply unavailable styling if applicable', () => {
        const mockTruck = { type: 'truck', name: 'Bob\'s Box Truck', vehicleClass: 'Box Truck', isAvailable: false };
        
        renderResultsList([mockTruck]);
        
        const container = document.getElementById('results-list-container');
        expect(container.innerHTML).toContain('Bob\'s Box Truck');
        expect(container.innerHTML).toContain('Box Truck');
        expect(container.innerHTML).toContain('Currently Unavailable');
        
        // Ensure it gets the unavailable CSS class modifier
        expect(container.querySelector('.result-item--unavailable')).not.toBeNull();
    });
});