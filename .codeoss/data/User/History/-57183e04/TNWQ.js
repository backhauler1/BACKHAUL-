/**
 * @jest-environment jsdom
 */

import { loadUserReviews } from './profileReviews';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

jest.mock('./apiUtil', () => ({ apiFetch: jest.fn() }));
jest.mock('./notifications', () => ({ showNotification: jest.fn() }));

describe('Profile Reviews UI (profileReviews.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        document.body.innerHTML = `<div id="reviews-container"></div>`;
        // Mock the global logged-in user ID
        document.body.dataset.userId = "1";
        window.confirm = jest.fn();
    });

    it('should render an empty state message if no reviews exist', async () => {
        apiFetch.mockResolvedValueOnce({ data: [], summary: { totalRatings: 0 } });
        
        await loadUserReviews('5', 'reviews-container');
        
        const container = document.getElementById('reviews-container');
        expect(container.innerHTML).toContain('No written reviews yet.');
    });

    it('should fetch and render a list of reviews and the average rating summary', async () => {
        const mockData = {
            data: [
                { review: 'Excellent driver!', rating: 5, reviewer_name: 'Alice', created_at: '2023-10-01T00:00:00Z', rater_id: 2, load_id: 10 }
            ],
            summary: { averageRating: 5.0, totalRatings: 1 },
            pagination: { currentPage: 1, totalPages: 1 }
        };
        apiFetch.mockResolvedValueOnce(mockData);

        await loadUserReviews('3', 'reviews-container');
        
        const container = document.getElementById('reviews-container');
        expect(apiFetch).toHaveBeenCalledWith('/api/users/3/reviews?page=1&limit=5');
        expect(container.innerHTML).toContain('Average Rating');
        expect(container.innerHTML).toContain('Excellent driver!');
        expect(container.innerHTML).toContain('Alice');
        
        // Verify Edit/Delete buttons are NOT rendered since rater_id (2) != current user (1)
        expect(container.querySelector('.edit-review-btn')).toBeNull();
    });

    it('should render Edit and Delete buttons for the user\'s own reviews and handle deletion', async () => {
        const mockData = {
            data: [
                // Note: rater_id is 1, matching the dataset.userId in beforeEach
                { review: 'My own review', rating: 4, reviewer_name: 'Me', created_at: '2023-10-01T00:00:00Z', rater_id: 1, load_id: 15 }
            ],
            summary: { averageRating: 4.0, totalRatings: 1 },
            pagination: { currentPage: 1, totalPages: 1 }
        };
        apiFetch.mockResolvedValueOnce(mockData); // Initial load mock
        
        await loadUserReviews('3', 'reviews-container');
        
        const container = document.getElementById('reviews-container');
        const deleteBtn = container.querySelector('.delete-review-btn');
        const editBtn = container.querySelector('.edit-review-btn');
        
        expect(deleteBtn).not.toBeNull();
        expect(editBtn).not.toBeNull();

        // --- Test Deletion ---
        window.confirm.mockReturnValueOnce(true);
        apiFetch.mockResolvedValueOnce({ message: 'Deleted' }); // Delete API call mock
        apiFetch.mockResolvedValueOnce({ data: [], summary: {} }); // Reload API call mock

        await deleteBtn.click();
        
        expect(window.confirm).toHaveBeenCalled();
        expect(apiFetch).toHaveBeenCalledWith('/api/loads/15/rate', { method: 'DELETE' });
        expect(showNotification).toHaveBeenCalledWith('Review deleted successfully.', 'success');
    });

    it('should load more reviews when the Load More button is clicked', async () => {
        apiFetch.mockResolvedValueOnce({ data: [{ review: 'Rev 1', rater_id: 2 }], pagination: { currentPage: 1, totalPages: 2 } }); // Initial load
        await loadUserReviews('3', 'reviews-container');

        const container = document.getElementById('reviews-container');
        const loadMoreBtn = Array.from(container.querySelectorAll('button')).find(btn => btn.textContent === 'Load More');
        expect(loadMoreBtn).not.toBeUndefined();

        apiFetch.mockClear();
        apiFetch.mockResolvedValueOnce({ data: [{ review: 'Rev 2', rater_id: 3 }], pagination: { currentPage: 2, totalPages: 2 } }); // Second load

        await loadMoreBtn.click();

        expect(apiFetch).toHaveBeenCalledWith('/api/users/3/reviews?page=2&limit=5');
    });
});