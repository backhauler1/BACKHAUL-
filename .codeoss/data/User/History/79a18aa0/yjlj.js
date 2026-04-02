/**
 * @jest-environment jsdom
 */

import { loadBids } from './bids';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

jest.mock('./apiUtil.js', () => ({ apiFetch: jest.fn() }));
jest.mock('./notifications.js', () => ({ showNotification: jest.fn() }));

describe('Bids UI (bids.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        document.body.innerHTML = `<div id="bids-container"></div>`;
        window.confirm = jest.fn();
    });

    it('should render an empty state message if there are no bids', async () => {
        apiFetch.mockResolvedValueOnce({ data: [] });
        await loadBids(10, 'bids-container');
        const container = document.getElementById('bids-container');
        expect(container.innerHTML).toContain('No bids placed yet.');
    });

    it('should fetch and render a list of bids, including an accept button', async () => {
        const mockBids = [
            { id: 5, driver_name: 'Driver Dan', driver_rating: '4.5', bid_amount: 500, notes: 'Fast', status: 'pending', created_at: new Date().toISOString() }
        ];
        apiFetch.mockResolvedValueOnce({ data: mockBids });
        await loadBids(10, 'bids-container');

        const container = document.getElementById('bids-container');
        expect(container.innerHTML).toContain('Driver Dan');
        expect(container.innerHTML).toContain('$500');
        expect(container.querySelector('button').textContent).toBe('Accept Bid');
    });

    it('should handle accepting a bid', async () => {
        const mockBids = [{ id: 5, status: 'pending', created_at: new Date().toISOString() }];
        apiFetch.mockResolvedValueOnce({ data: mockBids });
        await loadBids(10, 'bids-container');

        window.confirm.mockReturnValueOnce(true);
        apiFetch.mockResolvedValueOnce({ message: 'Success' }); // Mock accept
        apiFetch.mockResolvedValueOnce({ data: [] }); // Mock refresh

        document.querySelector('button').click();
        await new Promise(process.nextTick);
        expect(apiFetch).toHaveBeenCalledWith('/api/loads/10/bids/5/accept', { method: 'POST' });
    });
});