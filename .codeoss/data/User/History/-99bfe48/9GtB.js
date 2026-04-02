import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

let currentSearchTerm = '';
let currentPage = 1;

/**
 * Initializes the admin companies dashboard.
 */
export function initializeCompaniesAdminPage() {
    const searchInput = document.getElementById('company-search-input');
    const searchForm = document.getElementById('company-search-form');
    const tbody = document.getElementById('companies-table-body');

    // Initial load
    loadCompaniesDashboard(1);

    if (searchForm) {
        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const searchTerm = searchInput ? searchInput.value.trim() : '';
            if (searchTerm !== currentSearchTerm) {
                currentSearchTerm = searchTerm;
                loadCompaniesDashboard(1, currentSearchTerm);
            }
        });
    }

    if (tbody) {
        tbody.addEventListener('click', handleDeleteClick);
        tbody.addEventListener('click', handleSuspendClick);
    }
}

/**
 * Fetches and renders the list of companies.
 * @param {number} page The page number to fetch.
 * @param {string} search The search term to filter by.
 */
async function loadCompaniesDashboard(page = 1, search = '') {
    const tbody = document.getElementById('companies-table-body');
    const paginationContainer = document.getElementById('companies-pagination-controls');
    
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">Loading companies...</td></tr>';
    currentPage = page;
    currentSearchTerm = search;

    try {
        let url = `/api/companies?page=${page}&limit=15`;
        if (search) {
            url += `&search=${encodeURIComponent(search)}`;
        }

        const response = await apiFetch(url);
        const { data: companies, pagination } = response;

        if (companies.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No companies found.</td></tr>';
            if (paginationContainer) paginationContainer.innerHTML = '';
            return;
        }

        tbody.innerHTML = '';

        companies.forEach(company => {
            const tr = document.createElement('tr');
            
            const registrationDate = new Date(company.created_at).toLocaleDateString();
            const privacyDate = company.privacy_policy_agreed_at 
                ? new Date(company.privacy_policy_agreed_at).toLocaleString()
                : '<em class="text-muted">Not Recorded</em>';

            const isSuspended = !!company.is_suspended;
            const statusBadge = isSuspended 
                ? `<span class="status-badge" style="background: #f8d7da; color: #721c24; padding: 4px 8px; border-radius: 12px; font-size: 0.85em;">Suspended</span>`
                : `<span class="status-badge" style="background: #d4edda; color: #155724; padding: 4px 8px; border-radius: 12px; font-size: 0.85em;">Active</span>`;

            tr.innerHTML = `
                <td>#${company.id}</td>
                <td><strong>${company.name}</strong><br>${statusBadge}</td>
                <td>
                    ${company.owner_name || 'N/A'}<br>
                    <small class="text-muted">${company.owner_email || 'N/A'}</small>
                </td>
                <td>${registrationDate}</td>
                <td>${privacyDate}</td>
                <td class="actions-cell" style="text-align: center;">
                    <button class="btn-suspend-company" data-company-id="${company.id}" data-company-name="${company.name}" data-suspended="${isSuspended}" title="${isSuspended ? 'Unsuspend' : 'Suspend'} Company">${isSuspended ? 'Unsuspend' : 'Suspend'}</button>
                    <button class="btn-delete-company" data-company-id="${company.id}" data-company-name="${company.name}" title="Delete Company">Delete</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        if (paginationContainer && pagination.totalPages > 1) {
            renderPagination(pagination, paginationContainer);
        } else if (paginationContainer) {
            paginationContainer.innerHTML = '';
        }

    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: red;">Error: ${error.message}</td></tr>`;
        showNotification('Failed to fetch companies.', 'error');
    }
}

/**
 * Renders pagination controls.
 * @param {object} pagination The pagination object from the API.
 * @param {HTMLElement} container The container for the controls.
 */
function renderPagination(pagination, container) {
    const { currentPage, totalPages } = pagination;
    container.innerHTML = ''; // Clear previous controls

    const prevButton = document.createElement('button');
    prevButton.textContent = '« Previous';
    prevButton.disabled = currentPage <= 1;
    prevButton.className = 'pagination-btn';
    prevButton.addEventListener('click', () => loadCompaniesDashboard(currentPage - 1, currentSearchTerm));

    const pageIndicator = document.createElement('span');
    pageIndicator.textContent = `Page ${currentPage} of ${totalPages}`;
    pageIndicator.className = 'pagination-indicator';

    const nextButton = document.createElement('button');
    nextButton.textContent = 'Next »';
    nextButton.disabled = currentPage >= totalPages;
    nextButton.className = 'pagination-btn';
    nextButton.addEventListener('click', () => loadCompaniesDashboard(currentPage + 1, currentSearchTerm));

    container.append(prevButton, pageIndicator, nextButton);
}

/**
 * Handles the click event for deleting a company.
 * @param {Event} e The click event.
 */
async function handleDeleteClick(e) {
    if (!e.target.matches('.btn-delete-company')) return;

    const button = e.target;
    const companyId = button.dataset.companyId;
    const companyName = button.dataset.companyName;

    if (!confirm(`Are you sure you want to permanently delete the company "${companyName}" (ID: ${companyId})? This action cannot be undone.`)) {
        return;
    }

    button.disabled = true;
    button.textContent = 'Deleting...';

    try {
        const response = await apiFetch(`/api/companies/${companyId}`, {
            method: 'DELETE',
        });
        showNotification(response.message, 'success');
        loadCompaniesDashboard(currentPage, currentSearchTerm); // Refresh the view
    } catch (error) {
        showNotification(`Failed to delete company: ${error.message}`, 'error');
        button.disabled = false;
        button.textContent = 'Delete';
    }
}

/**
 * Handles the click event for suspending/unsuspending a company.
 * @param {Event} e The click event.
 */
async function handleSuspendClick(e) {
    if (!e.target.matches('.btn-suspend-company')) return;

    const button = e.target;
    const companyId = button.dataset.companyId;
    const companyName = button.dataset.companyName;
    const isSuspended = button.dataset.suspended === 'true';
    const actionText = isSuspended ? 'unsuspend' : 'suspend';

    if (!confirm(`Are you sure you want to ${actionText} the company "${companyName}" (ID: ${companyId})?`)) {
        return;
    }

    button.disabled = true;
    button.textContent = 'Updating...';

    try {
        const response = await apiFetch(`/api/companies/${companyId}/suspend`, {
            method: 'PATCH',
            body: { suspend: !isSuspended }
        });
        showNotification(response.message, 'success');
        loadCompaniesDashboard(currentPage, currentSearchTerm); // Refresh the view
    } catch (error) {
        showNotification(`Failed to ${actionText} company: ${error.message}`, 'error');
        button.disabled = false;
        button.textContent = isSuspended ? 'Unsuspend' : 'Suspend';
    }
}