/**
 * @jest-environment jsdom
 */

import { initializeMyTrucksPage } from './myTrucks.js';
import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

// Mock the modules that myTrucks.js depends on
jest.mock('./apiUtil.js', () => ({
    apiFetch: jest.fn(),
}));

jest.mock('./notifications.js', () => ({
    showNotification: jest.fn(),
}));

describe('My Trucks Page (myTrucks.js)', () => {
    beforeEach(() => {
        // Clear all mocks and reset the DOM before each test
        jest.clearAllMocks();
        document.body.innerHTML = '<div id="my-trucks-container"></div>';
        // Mock the global confirm function for deletion tests
        window.confirm = jest.fn();
    });

    it('should initialize the page, create UI controls, and load trucks', async () => {
        // Mock the initial API call to return an empty list
        apiFetch.mockResolvedValue({ data: [], pagination: {} });

        await initializeMyTrucksPage();

        // Check if the "Add Truck" section was created
        expect(document.getElementById('add-truck-section')).not.toBeNull();
        // Check if the sort dropdown was created
        expect(document.getElementById('my-trucks-sort-container')).not.toBeNull();
        // Check if it tried to fetch the trucks
        expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/trucks/me'));
        // Check if it rendered the "no trucks" message for an empty list
        expect(document.getElementById('my-trucks-container').innerHTML).toContain('You have not registered any trucks yet.');
    });

    it('should show an error message if fetching trucks fails', async () => {
        apiFetch.mockRejectedValue(new Error('Server is down'));

        await initializeMyTrucksPage();

        expect(document.getElementById('my-trucks-container').innerHTML).toContain('Failed to load your trucks: Server is down');
    });

    describe('Add New Truck Form', () => {
        it('should submit new truck data and refresh the list on success', async () => {
            // 1. Initial load is empty
            apiFetch.mockResolvedValueOnce({ data: [], pagination: {} });
            await initializeMyTrucksPage();

            // 2. Mock the POST request for registering a truck
            apiFetch.mockResolvedValueOnce({}); // Empty success response is fine
            
            // 3. Mock the refresh call after successful registration
            const mockNewTruck = { id: 1, name: 'New Mack', type: 'flatbed', home_base: 'Miami, FL', is_available: true };
            apiFetch.mockResolvedValueOnce({ data: [mockNewTruck], pagination: { totalPages: 1 } });

            // --- Simulate user interaction ---
            const form = document.getElementById('inline-add-truck-form');
            form.querySelector('input[name="truckName"]').value = 'New Mack';
            form.querySelector('select[name="truckType"]').value = 'flatbed';
            form.querySelector('input[name="homeBase"]').value = 'Miami, FL';

            // Dispatch submit event and wait for async operations to complete
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await new Promise(process.nextTick);

            // --- Assertions ---
            // Verify the POST call was made with FormData
            expect(apiFetch).toHaveBeenCalledWith('/api/trucks/register', {
                method: 'POST',
                body: expect.any(FormData)
            });
            
            // Verify success notification was shown
            expect(showNotification).toHaveBeenCalledWith('Truck registered successfully!', 'success');

            // Verify the list was re-rendered with the new truck
            expect(document.getElementById('my-trucks-container').innerHTML).toContain('New Mack');
        });
    });

    describe('Truck Card Actions', () => {
        const mockTrucks = [
            { id: 1, name: 'Big Red', type: 'dry_van', home_base: 'Chicago, IL', is_available: true, thumbnail_url: 'test.jpg' },
            { id: 2, name: 'Green Machine', type: 'reefer', home_base: 'LA, CA', is_available: false, thumbnail_url: 'test2.jpg' }
        ];

        beforeEach(async () => {
            // Load the page with mock trucks before each action test
            apiFetch.mockResolvedValue({ data: mockTrucks, pagination: { totalPages: 1 } });
            await initializeMyTrucksPage();
        });

        it('should delete a truck when delete button is clicked and confirmed', async () => {
            window.confirm.mockReturnValue(true); // Simulate user clicking "OK"

            apiFetch.mockResolvedValueOnce({}); // Mock the DELETE API call
            apiFetch.mockResolvedValueOnce({ data: [mockTrucks[1]], pagination: { totalPages: 1 } }); // Mock the refresh call

            const deleteBtn = document.querySelector('.delete-truck-btn[data-id="1"]');
            deleteBtn.click();
            await new Promise(process.nextTick);

            expect(window.confirm).toHaveBeenCalled();
            expect(apiFetch).toHaveBeenCalledWith('/api/trucks/1', { method: 'DELETE' });
            expect(showNotification).toHaveBeenCalledWith('Truck deleted successfully.', 'success');
            expect(document.getElementById('my-trucks-container').innerHTML).not.toContain('Big Red');
        });

        it('should toggle availability when the button is clicked', async () => {
            apiFetch.mockResolvedValueOnce({}); // Mock the PATCH API call
            const updatedTruck = { ...mockTrucks[0], is_available: false };
            apiFetch.mockResolvedValueOnce({ data: [updatedTruck, mockTrucks[1]], pagination: { totalPages: 1 } }); // Mock the refresh call

            const toggleBtn = document.querySelector('.toggle-availability-btn[data-id="1"]');
            toggleBtn.click();
            await new Promise(process.nextTick);

            expect(apiFetch).toHaveBeenCalledWith('/api/trucks/1/availability', {
                method: 'PATCH',
                body: { isAvailable: false } // Toggling from true to false
            });
            expect(showNotification).toHaveBeenCalledWith('Truck availability updated successfully.', 'success');
            expect(document.querySelector('.toggle-availability-btn[data-id="1"]').textContent).toContain('Mark Available');
        });

        it('should render an edit form when edit button is clicked', () => {
            const editBtn = document.querySelector('.edit-truck-btn[data-id="1"]');
            editBtn.click();

            const card = editBtn.closest('.truck-card');
            expect(card.querySelector('form.edit-truck-form')).not.toBeNull();
            expect(card.querySelector('input[name="truckName"]').value).toBe('Big Red');
        });

        it('should submit updated data from the edit form', async () => {
            const editBtn = document.querySelector('.edit-truck-btn[data-id="1"]');
            editBtn.click();
            
            apiFetch.mockResolvedValueOnce({}); // Mock the PUT API call
            const updatedTruck = { ...mockTrucks[0], name: 'Big Red Updated' };
            apiFetch.mockResolvedValueOnce({ data: [updatedTruck, mockTrucks[1]], pagination: { totalPages: 1 } }); // Mock the refresh call

            const editForm = document.querySelector('form.edit-truck-form');
            editForm.querySelector('input[name="truckName"]').value = 'Big Red Updated';
            
            editForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await new Promise(process.nextTick);

            expect(apiFetch).toHaveBeenCalledWith('/api/trucks/1', {
                method: 'PUT',
                body: expect.any(FormData)
            });
            expect(showNotification).toHaveBeenCalledWith('Truck updated successfully.', 'success');
            expect(document.getElementById('my-trucks-container').innerHTML).toContain('Big Red Updated');
        });
    });
});