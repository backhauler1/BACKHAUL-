/**
 * @jest-environment jsdom
 */

import { initializeAdminLeaderboard, exportLeaderboardCSV } from './adminReferrals';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

jest.mock('./apiUtil', () => ({ apiFetch: jest.fn() }));
jest.mock('./notifications', () => ({ showNotification: jest.fn() }));

describe('Admin Referrals Leaderboard UI', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        document.body.innerHTML = '<div id="leaderboard-container"></div>';
    });

    it('should fetch and render the leaderboard correctly', async () => {
        const mockData = {
            data: [
                { id: 1, name: 'Alice', email: 'alice@test.com', referral_code: 'ALICE1', total_referrals: 10 }
            ],
            pagination: { currentPage: 1, totalPages: 1, totalItems: 1 }
        };
        apiFetch.mockResolvedValueOnce(mockData);

        initializeAdminLeaderboard('leaderboard-container');
        await new Promise(process.nextTick); // Wait for async fetch

        const container = document.getElementById('leaderboard-container');
        expect(apiFetch).toHaveBeenCalledWith('/api/users/admin/top-referrers?page=1&limit=10');
        expect(container.innerHTML).toContain('Alice');
        expect(container.innerHTML).toContain('ALICE1');
        expect(container.innerHTML).toContain('10');
        expect(container.innerHTML).toContain('#1'); // Rank 1
    });

    it('should render pagination controls and handle clicks', async () => {
        const mockDataPage1 = {
            data: [{ id: 1, name: 'Alice', email: 'alice@test.com', referral_code: 'ALICE1', total_referrals: 10 }],
            pagination: { currentPage: 1, totalPages: 2, totalItems: 15 }
        };
        apiFetch.mockResolvedValueOnce(mockDataPage1);

        initializeAdminLeaderboard('leaderboard-container');
        await new Promise(process.nextTick);

        const nextBtn = document.getElementById('next-page-btn');
        expect(nextBtn).not.toBeNull();
        
        apiFetch.mockResolvedValueOnce({ data: [], pagination: {} }); // Mock page 2 fetch
        nextBtn.click();
        await new Promise(process.nextTick);

        expect(apiFetch).toHaveBeenCalledWith('/api/users/admin/top-referrers?page=2&limit=10');
    });

    it('should display an error message if the fetch fails', async () => {
        apiFetch.mockRejectedValueOnce(new Error('Network error'));
        jest.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console.error

        initializeAdminLeaderboard('leaderboard-container');
        await new Promise(process.nextTick);

        const container = document.getElementById('leaderboard-container');
        expect(container.innerHTML).toContain('Failed to load leaderboard.');
        expect(showNotification).toHaveBeenCalledWith('Error loading leaderboard: Network error', 'error');
    });

    it('should trigger the export API request and show a success notification', async () => {
        apiFetch.mockResolvedValueOnce({ message: 'Export queued.' });

        await exportLeaderboardCSV();

        expect(apiFetch).toHaveBeenCalledWith('/api/users/admin/top-referrers/export', {
            method: 'POST'
        });
        expect(showNotification).toHaveBeenCalledWith('Export queued.', 'success');
    });
});