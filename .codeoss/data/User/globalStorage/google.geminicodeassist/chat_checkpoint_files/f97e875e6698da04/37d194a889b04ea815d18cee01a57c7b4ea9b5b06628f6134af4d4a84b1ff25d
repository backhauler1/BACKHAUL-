/**
 * @jest-environment jsdom
 */

import { initializeCompaniesAdminPage } from './adminCompanies';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

jest.mock('./apiUtil', () => ({ apiFetch: jest.fn() }));
jest.mock('./notifications', () => ({ showNotification: jest.fn() }));

describe('Admin Companies UI (adminCompanies.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        document.body.innerHTML = `
            <form id="company-search-form">
                <input id="company-search-input" value="TestCo">
            </form>
            <tbody id="companies-table-body"></tbody>
            <div id="companies-pagination-controls"></div>
        `;
        window.confirm = jest.fn();
    });

    it('should fetch and render companies on initialization', async () => {
        const mockCompanies = [
            { id: 1, name: 'Active Co', owner_name: 'Owner 1', is_suspended: false, created_at: '2023-10-01' },
            { id: 2, name: 'Suspended Co', owner_name: 'Owner 2', is_suspended: true, created_at: '2023-10-02' }
        ];
        apiFetch.mockResolvedValueOnce({ data: mockCompanies, pagination: { totalPages: 1 } });

        // Await the function to ensure the DOM is populated before querying it.
        await initializeCompaniesAdminPage();

        const tbody = document.getElementById('companies-table-body');
        expect(apiFetch).toHaveBeenCalledWith('/api/companies?page=1&limit=15');
        expect(tbody.innerHTML).toContain('Active Co');
        expect(tbody.innerHTML).toContain('btn-suspend-company');
        expect(tbody.innerHTML).toContain('btn-delete-company');
    });

    it('should handle search form submission', async () => {
        apiFetch.mockResolvedValue({ data: [], pagination: {} }); // Mock for initial + search
        
        await initializeCompaniesAdminPage();
        
        const form = document.getElementById('company-search-form');
        form.dispatchEvent(new Event('submit', { cancelable: true }));

        expect(apiFetch).toHaveBeenCalledWith('/api/companies?page=1&limit=15&search=TestCo');
    });

    it('should handle suspending a company via delegated click event', async () => {
        apiFetch.mockResolvedValueOnce({ data: [{ id: 1, name: 'TestCo', is_suspended: false }], pagination: { totalPages: 1 } });
        await initializeCompaniesAdminPage();

        const suspendBtn = document.querySelector('.btn-suspend-company');
        window.confirm.mockReturnValueOnce(true);
        
        // Mock suspend API response
        apiFetch.mockResolvedValueOnce({ message: 'Company suspended.' });
        // Mock refresh API response
        apiFetch.mockResolvedValueOnce({ data: [], pagination: {} });

        // Trigger click natively so delegation catches it
        suspendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise(process.nextTick); // Wait for async handlers

        expect(window.confirm).toHaveBeenCalledWith('Are you sure you want to suspend the company "TestCo" (ID: 1)?');
        expect(apiFetch).toHaveBeenCalledWith('/api/companies/1/suspend', {
            method: 'PATCH',
            body: { suspend: true }
        });
        expect(showNotification).toHaveBeenCalledWith('Company suspended.', 'success');
    });

    it('should handle deleting a company via delegated click event', async () => {
        apiFetch.mockResolvedValueOnce({ data: [{ id: 1, name: 'TestCo', is_suspended: false }], pagination: { totalPages: 1 } });
        await initializeCompaniesAdminPage();

        const deleteBtn = document.querySelector('.btn-delete-company');
        window.confirm.mockReturnValueOnce(true);
        
        // Mock delete API response
        apiFetch.mockResolvedValueOnce({ message: 'Company deleted successfully.' });
        // Mock refresh API response
        apiFetch.mockResolvedValueOnce({ data: [], pagination: {} });

        // Trigger click natively so delegation catches it
        deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise(process.nextTick); // Wait for async handlers

        expect(window.confirm).toHaveBeenCalledWith('Are you sure you want to permanently delete the company "TestCo" (ID: 1)? This action cannot be undone.');
        expect(apiFetch).toHaveBeenCalledWith('/api/companies/1', { method: 'DELETE' });
        expect(showNotification).toHaveBeenCalledWith('Company deleted successfully.', 'success');
    });
});