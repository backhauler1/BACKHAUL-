import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

let currentSearchTerm = '';
let currentHistorySearchTerm = '';

export async function loadUsersDashboard(page = 1, search = '') {
    const tbody = document.getElementById('users-table-body');
    const paginationContainer = document.getElementById('users-pagination-controls');
    
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">Loading users...</td></tr>';
    currentSearchTerm = search;

    try {
        let url = `/api/users?page=${page}&limit=15`;
        if (search) {
            url += `&search=${encodeURIComponent(search)}`;
        }

        const response = await apiFetch(url);
        const { data: users, pagination } = response;

        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No users found.</td></tr>';
            if (paginationContainer) paginationContainer.innerHTML = '';
            return;
        }

        tbody.innerHTML = '';

        users.forEach(user => {
            const tr = document.createElement('tr');
            const penaltyCount = user.penalty_count || 0;
            
            // Highlight users with 3 or more penalties
            const penaltyStyle = penaltyCount >= 3 ? 'color: #dc3545; font-weight: bold;' : '';
            
            const statusBadge = user.is_suspended 
                ? `<span class="status-badge" style="background: #f8d7da; color: #721c24; padding: 4px 8px; border-radius: 12px; font-size: 0.85em;">Suspended</span>`
                : `<span class="status-badge" style="background: #d4edda; color: #155724; padding: 4px 8px; border-radius: 12px; font-size: 0.85em;">Active</span>`;

            tr.innerHTML = `
                <td>#${user.id}</td>
                <td><strong>${user.name}</strong><br><small class="text-muted">${user.email}</small></td>
                <td>${(user.roles || []).join(', ')}</td>
                <td style="${penaltyStyle}">${penaltyCount}</td>
                <td>${statusBadge}</td>
                <td class="actions-cell"></td>
            `;

            // Add Suspend / Unsuspend Button
            const toggleBtn = document.createElement('button');
            toggleBtn.className = user.is_suspended ? 'btn btn-outline-success btn-sm' : 'btn btn-outline-danger btn-sm';
            toggleBtn.textContent = user.is_suspended ? 'Unsuspend' : 'Suspend';
            toggleBtn.onclick = () => toggleUserSuspension(user.id, !user.is_suspended, toggleBtn);
            
            tr.querySelector('.actions-cell').appendChild(toggleBtn);
            tbody.appendChild(tr);
        });

        if (paginationContainer && pagination.totalPages > 1) {
            renderPagination(pagination, paginationContainer);
        } else if (paginationContainer) {
            paginationContainer.innerHTML = '';
        }

    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: red;">Error: ${error.message}</td></tr>`;
        showNotification('Failed to fetch users.', 'error');
    }
}

async function toggleUserSuspension(userId, suspend, btnElement) {
    const actionText = suspend ? 'suspend' : 'unsuspend';
    let reason = undefined;

    if (suspend) {
        const promptResult = prompt(`Are you sure you want to suspend user #${userId}?\nIf yes, please provide an optional reason (this will be emailed to the user):`);
        if (promptResult === null) return; // Admin clicked Cancel on the prompt
        reason = promptResult.trim();
    } else {
        if (!confirm(`Are you sure you want to unsuspend user #${userId}?`)) return;
    }

    const originalText = btnElement.textContent;
    btnElement.disabled = true;
    btnElement.textContent = 'Updating...';

    try {
        const response = await apiFetch(`/api/users/${userId}/suspend`, {
            method: 'PATCH',
            body: { suspend, reason }
        });
        showNotification(response.message, 'success');
        
        // Refresh current view to reflect changes
        loadUsersDashboard(1, currentSearchTerm);
    } catch (error) {
        showNotification(`Failed to ${actionText} user: ${error.message}`, 'error');
        btnElement.disabled = false;
        btnElement.textContent = originalText;
    }
}

export async function loadSuspensionHistory(page = 1, search = '') {
    const tbody = document.getElementById('suspension-history-table-body');
    const paginationContainer = document.getElementById('suspension-history-pagination-controls');
    
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Loading history...</td></tr>';
    currentHistorySearchTerm = search;

    try {
        let url = `/api/users/suspension-history?page=${page}&limit=15`;
        if (search) {
            url += `&search=${encodeURIComponent(search)}`;
        }

        const response = await apiFetch(url);
        const { data: history, pagination } = response;

        if (history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No suspension history found.</td></tr>';
            if (paginationContainer) paginationContainer.innerHTML = '';
            return;
        }

        tbody.innerHTML = '';

        history.forEach(record => {
            const tr = document.createElement('tr');
            
            const actionBadge = record.action === 'suspended' 
                ? `<span class="status-badge" style="background: #f8d7da; color: #721c24; padding: 4px 8px; border-radius: 12px; font-size: 0.85em;">Suspended</span>`
                : `<span class="status-badge" style="background: #d4edda; color: #155724; padding: 4px 8px; border-radius: 12px; font-size: 0.85em;">Unsuspended</span>`;

            tr.innerHTML = `
                <td>${new Date(record.created_at).toLocaleString()}</td>
                <td><strong>${record.target_user_name}</strong> (#${record.target_user_id})</td>
                <td><strong>${record.admin_name}</strong> (#${record.admin_id})</td>
                <td>${actionBadge}</td>
                <td>${record.reason || '<em>No reason provided</em>'}</td>
            `;

            tbody.appendChild(tr);
        });

        if (paginationContainer && pagination.totalPages > 1) {
            renderPagination(pagination, paginationContainer);
        } else if (paginationContainer) {
            paginationContainer.innerHTML = '';
        }

    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: red;">Error: ${error.message}</td></tr>`;
        showNotification('Failed to fetch suspension history.', 'error');
    }
}

export async function exportSuspensionHistoryCSV() {
    try {
        // Fetch a large limit to capture the entire history, retaining the current search filter
        let url = `/api/users/suspension-history?page=1&limit=10000`;
        if (currentHistorySearchTerm) {
            url += `&search=${encodeURIComponent(currentHistorySearchTerm)}`;
        }

        const response = await apiFetch(url);
        const { data: history } = response;

        if (!history || history.length === 0) {
            showNotification('No data to export.', 'info');
            return;
        }

        // Helper to safely escape CSV fields containing commas or quotes
        const escapeCSV = (str) => `"${String(str).replace(/"/g, '""')}"`;

        const headers = ['Date', 'Target User', 'Target ID', 'Admin Name', 'Admin ID', 'Action', 'Reason'];
        const csvRows = history.map(record => [
            escapeCSV(new Date(record.created_at).toLocaleString()),
            escapeCSV(record.target_user_name || ''),
            record.target_user_id,
            escapeCSV(record.admin_name || ''),
            record.admin_id,
            escapeCSV(record.action),
            escapeCSV(record.reason || '')
        ].join(','));

        const csvContent = [headers.join(','), ...csvRows].join('\n');
        
        // Create a Blob and trigger the download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const urlBlob = URL.createObjectURL(blob);
        
        link.setAttribute('href', urlBlob);
        link.setAttribute('download', `suspension_history_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(urlBlob);

    } catch (error) {
        showNotification(`Failed to export CSV: ${error.message}`, 'error');
    }
}