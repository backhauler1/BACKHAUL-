/**
 * @jest-environment jsdom
 */

import { initializeMyPostedLoadsPage } from './myPostedLoads.js';
import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';
import { promptPushNotifications } from './pushService.js';

// Mock the modules that myPostedLoads.js depends on
jest.mock('./apiUtil.js', () => ({
    apiFetch: jest.fn(),
}));

jest.mock('./notifications.js', () => ({
    showNotification: jest.fn(),
}));

jest.mock('./pushService.js', () => ({
    promptPushNotifications: jest.fn(),
}));

describe('My Posted Loads Page (myPostedLoads.js)', () => {
    beforeEach(() => {
        // Clear all mocks and reset the DOM before each test
        jest.clearAllMocks();
        jest.useFakeTimers();
        document.body.innerHTML = '<div id="my-posted-loads-container"></div>';
        // Mock the global prompt/confirm functions for action tests
        window.prompt = jest.fn();
        window.confirm = jest.fn();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should initialize the page, create UI controls, and load posted loads', async () => {
        // Mock the initial API call to return an empty list
        apiFetch.mockResolvedValue({ data: [], pagination: {} });

        await initializeMyPostedLoadsPage();

        // Check if the "Post New Load" section was created
        expect(document.getElementById('post-load-section')).not.toBeNull();
        // Check if the search and sort controls were created
        expect(document.getElementById('my-posted-loads-controls-container')).not.toBeNull();
        // Check if it tried to fetch the loads
        expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/loads/posted'));
        // Check if it rendered the "no loads" message for an empty list
        expect(document.getElementById('my-posted-loads-container').innerHTML).toContain('You have not posted any loads yet.');
    });

    it('should show an error message if fetching loads fails', async () => {
        apiFetch.mockRejectedValue(new Error('API is down'));

        await initializeMyPostedLoadsPage();

        expect(document.getElementById('my-posted-loads-container').innerHTML).toContain('Failed to load your posted loads: API is down');
    });

    describe('Post New Load Form', () => {
        beforeEach(async () => {
            // Initial load is empty
            apiFetch.mockResolvedValue({ data: [], pagination: {} });
            await initializeMyPostedLoadsPage();
        });

        it('should show and hide the form when toggle/cancel buttons are clicked', () => {
            const toggleBtn = document.getElementById('toggle-post-load-btn');
            const cancelBtn = document.getElementById('cancel-post-load-btn');
            const formContainer = document.getElementById('post-load-form-container');

            expect(formContainer.style.display).toBe('none');
            
            toggleBtn.click();
            expect(formContainer.style.display).toBe('block');

            cancelBtn.click();
            expect(formContainer.style.display).toBe('none');
        });

        it('should submit new load data and refresh the list on success', async () => {
            // 1. Mock the POST request for posting a load
            apiFetch.mockResolvedValueOnce({}); // Empty success response is fine
            
            // 2. Mock the refresh call after successful posting
            const mockNewLoad = { id: 1, title: 'New Load', pickup_address: 'Miami, FL', delivery_address: 'Orlando, FL', status: 'available' };
            apiFetch.mockResolvedValueOnce({ data: [mockNewLoad], pagination: { totalPages: 1 } });

            // --- Simulate user interaction ---
            const form = document.getElementById('inline-post-load-form');
            form.querySelector('input[name="title"]').value = 'New Load';
            form.querySelector('input[name="pickupAddress"]').value = 'Miami, FL';
            form.querySelector('input[name="deliveryAddress"]').value = 'Orlando, FL';

            // Dispatch submit event and wait for async operations to complete
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await jest.runAllTimersAsync();

            // --- Assertions ---
            expect(apiFetch).toHaveBeenCalledWith('/api/loads/post', {
                method: 'POST',
                body: expect.any(FormData)
            });
            expect(showNotification).toHaveBeenCalledWith('Load posted successfully!', 'success');
            expect(document.getElementById('my-posted-loads-container').innerHTML).toContain('New Load');

            // Check that push notification prompt is called after a delay
            expect(promptPushNotifications).toHaveBeenCalled();
        });
    });

    describe('Load Card Actions', () => {
        const mockLoads = [
            { id: 1, title: 'Machinery', pickup_address: 'Chicago, IL', delivery_address: 'Detroit, MI', status: 'available' },
            { id: 2, title: 'Produce', pickup_address: 'LA, CA', delivery_address: 'SF, CA', status: 'assigned' }
        ];

        beforeEach(async () => {
            // Load the page with mock loads before each action test
            apiFetch.mockResolvedValue({ data: mockLoads, pagination: { totalPages: 1 } });
            await initializeMyPostedLoadsPage();
        });

        it('should cancel a load when cancel button is clicked with a reason', async () => {
            window.prompt.mockReturnValue('Changed my mind'); // Simulate user entering a reason

            apiFetch.mockResolvedValueOnce({}); // Mock the DELETE API call
            apiFetch.mockResolvedValueOnce({ data: [mockLoads[1]], pagination: { totalPages: 1 } }); // Mock the refresh call

            const cancelBtn = document.querySelector('.cancel-load-btn[data-id="1"]');
            cancelBtn.click();
            await jest.runAllTimersAsync();

            expect(window.prompt).toHaveBeenCalled();
            expect(apiFetch).toHaveBeenCalledWith('/api/loads/1?reason=Changed%20my%20mind', { method: 'DELETE' });
            expect(showNotification).toHaveBeenCalledWith('Load cancelled successfully.', 'success');
            expect(document.getElementById('my-posted-loads-container').innerHTML).not.toContain('Machinery');
        });

        it('should render an edit form when edit button is clicked', () => {
            const editBtn = document.querySelector('.edit-load-btn[data-id="1"]');
            editBtn.click();

            // After the click, the card's innerHTML is replaced. We must re-select it from the DOM.
            const card = document.querySelector('.load-card');
            expect(card.querySelector('form.edit-load-form')).not.toBeNull();
            expect(card.querySelector('input[name="title"]').value).toBe('Machinery');
        });

        it('should submit updated data from the edit form', async () => {
            const editBtn = document.querySelector('.edit-load-btn[data-id="1"]');
            editBtn.click();
            
            apiFetch.mockResolvedValueOnce({}); // Mock the PUT API call
            const updatedLoad = { ...mockLoads[0], title: 'Heavy Machinery' };
            apiFetch.mockResolvedValueOnce({ data: [updatedLoad, mockLoads[1]], pagination: { totalPages: 1 } }); // Mock the refresh call

            const editForm = document.querySelector('form.edit-load-form');
            editForm.querySelector('input[name="title"]').value = 'Heavy Machinery';
            
            editForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await jest.runAllTimersAsync();

            expect(apiFetch).toHaveBeenCalledWith('/api/loads/1', {
                method: 'PUT',
                body: expect.any(FormData)
            });
            expect(showNotification).toHaveBeenCalledWith('Load updated successfully.', 'success');
            expect(document.getElementById('my-posted-loads-container').innerHTML).toContain('Heavy Machinery');
        });

        it('should render a "Track Status" link for non-available loads', () => {
            const trackLink = document.querySelector('a[href="/loads/2/status"]');
            expect(trackLink).not.toBeNull();
            expect(trackLink.textContent).toBe('Track Status');
        });
    });
});