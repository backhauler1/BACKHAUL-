/**
 * @jest-environment jsdom
 */

import { initializeInvoicesPage } from './invoices';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

jest.mock('./apiUtil.js', () => ({ apiFetch: jest.fn() }));
jest.mock('./notifications.js', () => ({ showNotification: jest.fn() }));

describe('Invoices UI (invoices.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        document.body.innerHTML = `
            <div id="invoices-list-container"></div>
            <div id="invoices-pagination-controls"></div>
        `;
        window.confirm = jest.fn();

        window.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
        window.URL.revokeObjectURL = jest.fn();
    });

    it('should fetch and render invoices on initialization', async () => {
        const mockOrders = [
            { id: 1, created_at: '2023-10-01', amount: 5000, currency: 'usd', status: 'succeeded' },
            { id: 2, created_at: '2023-10-02', amount: 2500, currency: 'usd', status: 'failed' }
        ];
        apiFetch.mockResolvedValueOnce({ data: mockOrders, pagination: { totalPages: 1 } });

        await initializeInvoicesPage();

        const container = document.getElementById('invoices-list-container');
        expect(apiFetch).toHaveBeenCalledWith('/api/orders/history?page=1&limit=10&search=&sortBy=created_at&sortOrder=desc&startDate=&endDate=');
        expect(container.innerHTML).toContain('#000001');
        expect(container.innerHTML).toContain('$50.00');
        expect(container.innerHTML).toContain('btn-cancel'); // Cancel button for success
        expect(container.innerHTML).toContain('btn-retry');  // Retry button for failed
    });

    it('should handle cancel order correctly', async () => {
        const mockOrders = [{ id: 1, amount: 5000, currency: 'usd', status: 'succeeded' }];
        apiFetch.mockResolvedValueOnce({ data: mockOrders, pagination: { totalPages: 1 } });
        
        await initializeInvoicesPage();

        const cancelBtn = document.querySelector('.btn-cancel');
        window.confirm.mockReturnValueOnce(true); // User clicks "OK"
        apiFetch.mockResolvedValueOnce({ message: 'Success' }); // Mock the cancel request
        apiFetch.mockResolvedValueOnce({ data: [], pagination: {} }); // Mock the refresh request

        await cancelBtn.click();

        expect(window.confirm).toHaveBeenCalled();
        expect(apiFetch).toHaveBeenCalledWith('/api/orders/1/cancel', { method: 'POST' });
        expect(showNotification).toHaveBeenCalledWith('Order cancelled and refunded successfully.', 'success');
    });

    it('should redirect on retry payment', async () => {
        const mockOrders = [{ id: 5, amount: 2500, currency: 'usd', status: 'failed' }];
        apiFetch.mockResolvedValueOnce({ data: mockOrders, pagination: { totalPages: 1 } });
        
        await initializeInvoicesPage();

        const retryBtn = document.querySelector('.btn-retry');
        
        // Mock window.location
        window.history.pushState({}, '', '/');

        retryBtn.click();

        expect(window.location.href).toContain('/checkout?retryOrder=5');
    });

    it('should render pagination controls if there are multiple pages', async () => {
        apiFetch.mockResolvedValueOnce({ data: [{ id: 1, amount: 1000, currency: 'usd', status: 'succeeded' }], pagination: { currentPage: 1, totalPages: 2 } });
        
        await initializeInvoicesPage();

        const pagination = document.getElementById('invoices-pagination-controls');
        expect(pagination.innerHTML).toContain('Next »');
        
        // Test Next button click
        apiFetch.mockClear();
        apiFetch.mockResolvedValueOnce({ data: [], pagination: {} });
        pagination.querySelector('button:last-child').click();
        
        expect(apiFetch).toHaveBeenCalledWith('/api/orders/history?page=2&limit=10&search=&sortBy=created_at&sortOrder=desc&startDate=&endDate=');
    });

    it('should export invoices to CSV', async () => {
        apiFetch.mockResolvedValueOnce({ data: [], pagination: {} });
        await initializeInvoicesPage();

        const exportBtn = document.getElementById('invoices-export-btn');
        const mockBlob = new Blob(['mock-csv-data'], { type: 'text/csv' });
        apiFetch.mockResolvedValueOnce(mockBlob);

        await exportBtn.click();

        expect(apiFetch).toHaveBeenCalledWith('/api/orders/history/export?search=&sortBy=created_at&sortOrder=desc&startDate=&endDate=', { method: 'GET', responseType: 'blob' });
        expect(window.URL.createObjectURL).toHaveBeenCalledWith(mockBlob);
        expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });
});