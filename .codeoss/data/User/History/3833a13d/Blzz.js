import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

let leaderboardContainer;
let currentPage = 1;
const LIMIT = 10;

/**
 * Initializes the Admin Referral Leaderboard.
 * @param {string} containerId - The ID of the DOM element to render the table into.
 */
export function initializeAdminLeaderboard(containerId) {
    leaderboardContainer = document.getElementById(containerId);
    if (!leaderboardContainer) return;

    fetchAndRenderLeaderboard(1);
}

async function fetchAndRenderLeaderboard(page) {
    currentPage = page;
    leaderboardContainer.innerHTML = '<p style="color: #666;">Loading leaderboard...</p>';

    try {
        const response = await apiFetch(`/api/users/admin/top-referrers?page=${currentPage}&limit=${LIMIT}`);
        const referrers = response.data;
        const pagination = response.pagination;

        renderTable(referrers, pagination);
    } catch (error) {
        console.error('Leaderboard error:', error);
        leaderboardContainer.innerHTML = '<p style="color: #dc3545;">Failed to load leaderboard.</p>';
        showNotification(`Error loading leaderboard: ${error.message}`, 'error');
    }
}

function renderTable(referrers, pagination) {
    if (!referrers || referrers.length === 0) {
        leaderboardContainer.innerHTML = '<p style="color: #666; font-style: italic;">No successful referrals found yet.</p>';
        return;
    }

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.backgroundColor = '#fff';
    table.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
    
    const exportBtn = document.createElement('button');
    exportBtn.id = 'export-csv-btn';
    exportBtn.textContent = 'Export CSV';
    exportBtn.style.cssText = 'margin-bottom: 10px; padding: 8px 16px; cursor: pointer; background-color: #28a745; color: #fff; border: none; border-radius: 4px;';
    exportBtn.addEventListener('click', exportLeaderboardCSV);

    table.innerHTML = `
        <thead>
            <tr style="background-color: #f8f9fa; text-align: left;">
                <th style="padding: 12px; border-bottom: 2px solid #dee2e6;">Rank</th>
                <th style="padding: 12px; border-bottom: 2px solid #dee2e6;">Name</th>
                <th style="padding: 12px; border-bottom: 2px solid #dee2e6;">Email</th>
                <th style="padding: 12px; border-bottom: 2px solid #dee2e6;">Referral Code</th>
                <th style="padding: 12px; border-bottom: 2px solid #dee2e6;">Successful Referrals</th>
            </tr>
        </thead>
        <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    const startIndex = (pagination.currentPage - 1) * LIMIT;

    referrers.forEach((referrer, index) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #e9ecef';
        tr.innerHTML = `
            <td style="padding: 12px; color: #6c757d;">#${startIndex + index + 1}</td>
            <td style="padding: 12px; font-weight: bold; color: #333;">${referrer.name}</td>
            <td style="padding: 12px; color: #555;">${referrer.email}</td>
            <td style="padding: 12px;"><span style="background: #e8f4f8; padding: 4px 8px; border-radius: 4px; font-family: monospace; color: #007bff;">${referrer.referral_code || 'N/A'}</span></td>
            <td style="padding: 12px; color: #28a745; font-weight: bold; font-size: 1.1em;">${referrer.total_referrals}</td>
        `;
        tbody.appendChild(tr);
    });

    leaderboardContainer.innerHTML = '';
    leaderboardContainer.appendChild(exportBtn);
    leaderboardContainer.appendChild(table);

    if (pagination && pagination.totalPages > 1) {
        renderPagination(pagination);
    }
}

function renderPagination(pagination) {
    const controlsHTML = `
        <div style="margin-top: 20px; display: flex; justify-content: space-between; align-items: center;">
            <button id="prev-page-btn" style="padding: 8px 16px; cursor: pointer;" ${pagination.currentPage <= 1 ? 'disabled' : ''}>« Previous</button>
            <span style="color: #666; font-size: 0.9em;">Page ${pagination.currentPage} of ${pagination.totalPages}</span>
            <button id="next-page-btn" style="padding: 8px 16px; cursor: pointer;" ${pagination.currentPage >= pagination.totalPages ? 'disabled' : ''}>Next »</button>
        </div>
    `;
    
    leaderboardContainer.insertAdjacentHTML('beforeend', controlsHTML);

    document.getElementById('prev-page-btn')?.addEventListener('click', () => fetchAndRenderLeaderboard(pagination.currentPage - 1));
    document.getElementById('next-page-btn')?.addEventListener('click', () => fetchAndRenderLeaderboard(pagination.currentPage + 1));
}

export async function exportLeaderboardCSV() {
    try {
        const response = await apiFetch('/api/users/admin/top-referrers/export', {
            method: 'POST'
        });
        showNotification(response.message || 'Export queued. You will receive an email shortly.', 'success');
    } catch (error) {
        showNotification(`Failed to export CSV: ${error.message}`, 'error');
    }
}