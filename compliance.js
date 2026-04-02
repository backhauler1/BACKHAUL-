import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

export async function loadComplianceDocuments(companyId, containerId, isAdmin = false) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<p>Loading documents...</p>';

    try {
        const response = await apiFetch(`/api/companies/${companyId}/documents`);
        const docs = response.data;

        if (!docs || docs.length === 0) {
            container.innerHTML = '<p>No compliance documents uploaded.</p>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'documents-table';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Type</th>
                    <th>Uploaded At</th>
                    <th>Expires At</th>
                    <th>Status</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');

        docs.forEach(doc => {
            const tr = document.createElement('tr');
            
            const expiresText = doc.expires_at ? new Date(doc.expires_at).toLocaleDateString() : 'N/A';
            const statusBadge = doc.is_verified 
                ? '<span class="badge badge-success" style="background-color: #28a745; color: white; padding: 2px 6px; border-radius: 4px;">Verified</span>'
                : '<span class="badge badge-warning" style="background-color: #ffc107; color: black; padding: 2px 6px; border-radius: 4px;">Pending Verification</span>';

            tr.innerHTML = `
                <td>${doc.document_type}</td>
                <td>${new Date(doc.uploaded_at).toLocaleDateString()}</td>
                <td>${expiresText}</td>
                <td>${statusBadge}</td>
                <td class="actions-cell"></td>
            `;

            const actionsCell = tr.querySelector('.actions-cell');

            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.className = 'btn btn-danger btn-sm';
            deleteBtn.addEventListener('click', async () => {
                if (!confirm('Are you sure you want to delete this document?')) return;
                try {
                    await apiFetch(`/api/companies/${companyId}/documents/${doc.id}`, { method: 'DELETE' });
                    showNotification('Document deleted.', 'success');
                    loadComplianceDocuments(companyId, containerId, isAdmin);
                } catch (error) {
                    showNotification(`Failed to delete: ${error.message}`, 'error');
                }
            });
            actionsCell.appendChild(deleteBtn);

            if (isAdmin) {
                const verifyBtn = document.createElement('button');
                verifyBtn.textContent = doc.is_verified ? 'Unverify' : 'Verify';
                verifyBtn.className = 'btn btn-info btn-sm ml-2';
                verifyBtn.style.marginLeft = '5px';
                verifyBtn.addEventListener('click', async () => {
                    try {
                        await apiFetch(`/api/companies/${companyId}/documents/${doc.id}/verify`, {
                            method: 'PATCH',
                            body: { is_verified: !doc.is_verified }
                        });
                        showNotification('Document verification updated.', 'success');
                        loadComplianceDocuments(companyId, containerId, isAdmin);
                    } catch (error) {
                        showNotification(`Failed to update verification: ${error.message}`, 'error');
                    }
                });
                actionsCell.appendChild(verifyBtn);
            }

            tbody.appendChild(tr);
        });

        container.innerHTML = '';
        container.appendChild(table);
    } catch (error) {
        container.innerHTML = `<p style="color: red;">Failed to load documents: ${error.message}</p>`;
    }
}

window.loadComplianceDocuments = loadComplianceDocuments;