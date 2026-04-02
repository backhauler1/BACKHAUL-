/**
 * @jest-environment jsdom
 */

import { loadUsersDashboard, loadSuspensionHistory, exportSuspensionHistoryCSV } from './adminUsers';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

// Mock the imported utility functions
jest.mock('./apiUtil', () => ({
    apiFetch: jest.fn()
}));

jest.mock('./notifications', () => ({
    showNotification: jest.fn()
}));

describe('Admin Users Dashboard (adminUsers.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Set up the dummy DOM required by the functions
        document.body.innerHTML = `
            <table>
                <tbody id="users-table-body"></tbody>
            </table>
            <div id="users-pagination-controls"></div>
            
            <table>
                <tbody id="suspension-history-table-body"></tbody>
            </table>
            <div id="suspension-history-pagination-controls"></div>
        `;

        // Mock browser dialogs
        window.prompt = jest.fn();
        window.confirm = jest.fn();
    });

    describe('loadUsersDashboard', () => {
        it('should fetch and render users correctly', async () => {
            const mockUsers = [
                { id: 1, name: 'Active User', email: 'active@test.com', roles: ['user'], penalty_count: 0, is_suspended: false },
                { id: 2, name: 'Suspended Driver', email: 'driver@test.com', roles: ['driver'], penalty_count: 3, is_suspended: true }
            ];
            
            apiFetch.mockResolvedValueOnce({
                data: mockUsers,
                pagination: { currentPage: 1, totalPages: 1, totalItems: 2 }
            });

            await loadUsersDashboard();

            const tbody = document.getElementById('users-table-body');
            const rows = tbody.querySelectorAll('tr');

            expect(apiFetch).toHaveBeenCalledWith('/api/users?page=1&limit=15');
            expect(rows.length).toBe(2);
            
            // Verify Active User Row
            expect(rows[0].innerHTML).toContain('Active User');
            expect(rows[0].innerHTML).toContain('Active');
            expect(rows[0].querySelector('button').textContent).toBe('Suspend');
            
            // Verify Suspended User Row (with penalty styling)
            expect(rows[1].innerHTML).toContain('Suspended Driver');
            expect(rows[1].innerHTML).toContain('Suspended');
            expect(rows[1].innerHTML).toContain('color: #dc3545; font-weight: bold;'); // Penalty style check
            expect(rows[1].querySelector('button').textContent).toBe('Unsuspend');
        });

        it('should show a "No users found" message when data is empty', async () => {
            apiFetch.mockResolvedValueOnce({ data: [], pagination: {} });

            await loadUsersDashboard(2, 'UnknownSearch');

            expect(apiFetch).toHaveBeenCalledWith('/api/users?page=2&limit=15&search=UnknownSearch');
            const tbody = document.getElementById('users-table-body');
            expect(tbody.innerHTML).toContain('No users found.');
        });

        it('should handle API errors gracefully and show a notification', async () => {
            apiFetch.mockRejectedValueOnce(new Error('Network error'));

            await loadUsersDashboard();

            const tbody = document.getElementById('users-table-body');
            expect(tbody.innerHTML).toContain('Error: Network error');
            expect(showNotification).toHaveBeenCalledWith('Failed to fetch users.', 'error');
        });
    });

    describe('toggleUserSuspension (via button click)', () => {
        it('should suspend a user, supply a reason via prompt, and refresh the dashboard', async () => {
            // Setup: Load a single active user
            apiFetch.mockResolvedValueOnce({
                data: [{ id: 5, name: 'Rule Breaker', is_suspended: false }],
                pagination: { totalPages: 1 }
            });
            await loadUsersDashboard();

            // Find the suspend button
            const suspendBtn = document.querySelector('#users-table-body button');
            
            // Mock user entering a reason in the prompt
            window.prompt.mockReturnValue('Violation of terms of service');
            
            // Mock the PATCH request succeeding
            apiFetch.mockResolvedValueOnce({ message: 'User suspended successfully' });
            
            // Mock the subsequent reload request
            apiFetch.mockResolvedValueOnce({ data: [], pagination: {} });

            // Trigger the click handler
            await suspendBtn.onclick();

            expect(window.prompt).toHaveBeenCalledWith(expect.stringContaining('suspend user #5'));
            expect(apiFetch).toHaveBeenCalledWith('/api/users/5/suspend', {
                method: 'PATCH',
                body: { suspend: true, reason: 'Violation of terms of service' }
            });
            expect(showNotification).toHaveBeenCalledWith('User suspended successfully', 'success');
            expect(suspendBtn.disabled).toBe(false); // Because it refreshes and replaces DOM, but realistically we check the API calls
        });

        it('should unsuspend a user via confirm dialog', async () => {
            apiFetch.mockResolvedValueOnce({
                data: [{ id: 8, name: 'Reformed User', is_suspended: true }],
                pagination: { totalPages: 1 }
            });
            await loadUsersDashboard();

            const unsuspendBtn = document.querySelector('#users-table-body button');
            
            // Mock user clicking "OK" on confirm
            window.confirm.mockReturnValue(true);
            apiFetch.mockResolvedValueOnce({ message: 'User unsuspended successfully' });
            apiFetch.mockResolvedValueOnce({ data: [], pagination: {} });

            await unsuspendBtn.onclick();

            expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('unsuspend user #8'));
            expect(apiFetch).toHaveBeenCalledWith('/api/users/8/suspend', {
                method: 'PATCH',
                body: { suspend: false, reason: undefined }
            });
        });
    });

    describe('loadSuspensionHistory', () => {
        it('should fetch and render suspension history logs', async () => {
            const mockHistory = [
                { created_at: '2023-10-01T12:00:00Z', target_user_name: 'Bad Actor', target_user_id: 10, admin_name: 'SuperAdmin', admin_id: 1, action: 'suspended', reason: 'Spamming' }
            ];

            apiFetch.mockResolvedValueOnce({
                data: mockHistory,
                pagination: { currentPage: 1, totalPages: 1, totalItems: 1 }
            });

            await loadSuspensionHistory(1, 'Bad Actor');

            expect(apiFetch).toHaveBeenCalledWith('/api/users/suspension-history?page=1&limit=15&search=Bad%20Actor');
            
            const rows = document.querySelectorAll('#suspension-history-table-body tr');
            expect(rows.length).toBe(1);
            expect(rows[0].innerHTML).toContain('Bad Actor');
            expect(rows[0].innerHTML).toContain('SuperAdmin');
            expect(rows[0].innerHTML).toContain('Spamming');
            expect(rows[0].innerHTML).toContain('Suspended'); // Badge text
        });
    });

    describe('exportSuspensionHistoryCSV', () => {
        beforeEach(() => {
            window.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
            window.URL.revokeObjectURL = jest.fn();
        });

        it('should trigger the export API request and download the CSV', async () => {
            const mockBlob = new Blob(['mock,csv'], { type: 'text/csv' });
            apiFetch.mockResolvedValueOnce(mockBlob);

            await exportSuspensionHistoryCSV();

            expect(apiFetch).toHaveBeenCalledWith('/api/users/suspension-history/export', {
                method: 'POST',
                body: { search: '' }, // Uses currentHistorySearchTerm which defaults to ''
                responseType: 'blob'
            });
            expect(window.URL.createObjectURL).toHaveBeenCalledWith(mockBlob);
            expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
            expect(showNotification).toHaveBeenCalledWith('CSV downloaded successfully.', 'success');
        });
    });
});