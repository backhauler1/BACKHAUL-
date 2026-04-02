/**
 * @jest-environment jsdom
 */

import { loadComplianceDocuments } from './compliance';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

jest.mock('./apiUtil.js', () => ({ apiFetch: jest.fn() }));
jest.mock('./notifications.js', () => ({ showNotification: jest.fn() }));

describe('Compliance UI (compliance.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        document.body.innerHTML = `<div id="docs-container"></div>`;
        window.confirm = jest.fn();
    });

    it('should render documents with delete buttons', async () => {
        const mockDocs = [{ id: 1, document_type: 'COI', uploaded_at: new Date().toISOString(), is_verified: false }];
        apiFetch.mockResolvedValueOnce({ data: mockDocs });
        
        await loadComplianceDocuments(5, 'docs-container', false); // isAdmin = false
        
        const container = document.getElementById('docs-container');
        expect(container.innerHTML).toContain('COI');
        expect(container.innerHTML).toContain('Pending Verification');
        expect(container.querySelector('.btn-danger')).not.toBeNull(); // Delete btn
        expect(container.querySelector('.btn-info')).toBeNull(); // Verify btn should be missing for non-admins
    });

    it('should render verify buttons if user is an admin', async () => {
        const mockDocs = [{ id: 1, document_type: 'COI', uploaded_at: new Date().toISOString(), is_verified: true }];
        apiFetch.mockResolvedValueOnce({ data: mockDocs });
        
        await loadComplianceDocuments(5, 'docs-container', true); // isAdmin = true
        
        const container = document.getElementById('docs-container');
        expect(container.innerHTML).toContain('Verified');
        expect(container.querySelector('.btn-info').textContent).toBe('Unverify'); // Should say Unverify since it's already verified
    });

    it('should handle document deletion', async () => {
        const mockDocs = [{ id: 1, document_type: 'COI', uploaded_at: new Date().toISOString() }];
        apiFetch.mockResolvedValueOnce({ data: mockDocs });
        await loadComplianceDocuments(5, 'docs-container', false);

        const deleteBtn = document.querySelector('.btn-danger');
        window.confirm.mockReturnValueOnce(true);
        
        apiFetch.mockResolvedValueOnce({ message: 'Deleted' }); // Delete req
        apiFetch.mockResolvedValueOnce({ data: [] }); // Refresh req

        await deleteBtn.click();
        
        expect(window.confirm).toHaveBeenCalled();
        expect(apiFetch).toHaveBeenCalledWith('/api/companies/5/documents/1', { method: 'DELETE' });
        expect(showNotification).toHaveBeenCalledWith('Document deleted.', 'success');
    });

    it('should handle document verification', async () => {
        const mockDocs = [{ id: 1, document_type: 'COI', uploaded_at: new Date().toISOString(), is_verified: false }];
        apiFetch.mockResolvedValueOnce({ data: mockDocs });
        await loadComplianceDocuments(5, 'docs-container', true);

        const verifyBtn = document.querySelector('.btn-info');
        
        apiFetch.mockResolvedValueOnce({ message: 'Document verification updated.' }); // Verify req
        apiFetch.mockResolvedValueOnce({ data: [] }); // Refresh req

        await verifyBtn.click();
        
        expect(apiFetch).toHaveBeenCalledWith('/api/companies/5/documents/1/verify', { 
            method: 'PATCH',
            body: { is_verified: true }
        });
        expect(showNotification).toHaveBeenCalledWith('Document verification updated.', 'success');
    });
});