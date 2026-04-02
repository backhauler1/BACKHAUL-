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

    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Loading companies...</td></tr>';
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
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No companies found.</td></tr>';
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

            tr.innerHTML = `
                <td>#${company.id}</td>
                <td><strong>${company.name}</strong></td>
                <td>
                    ${company.owner_name || 'N/A'}<br>
                    <small class="text-muted">${company.owner_email || 'N/A'}</small>
                </td>
                <td>${registrationDate}</td>
                <td>${privacyDate}</td>
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