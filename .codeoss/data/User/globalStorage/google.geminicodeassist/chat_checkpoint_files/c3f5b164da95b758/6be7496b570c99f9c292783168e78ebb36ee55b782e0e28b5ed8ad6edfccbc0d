import { showNotification } from './notifications.js';
import { apiFetch } from './apiUtil.js';

// Keep track of the main container elements
let invoicesContainer;
let paginationContainer;

/**
 * Initializes the invoices page by setting up containers and fetching the first page.
 */
export function initializeInvoicesPage() {
    invoicesContainer = document.getElementById('invoices-list-container');
    paginationContainer = document.getElementById('invoices-pagination-controls'); // New container for controls

    if (!invoicesContainer) {
        return; // This page doesn't have the required container, so do nothing.
    }

    // Add search container if it doesn't exist
    if (!document.getElementById('invoices-search-container')) {
        const searchContainer = document.createElement('div');
        searchContainer.id = 'invoices-search-container';
        searchContainer.style.marginBottom = '20px';
        searchContainer.style.display = 'flex';
        searchContainer.style.justifyContent = 'space-between';
        searchContainer.style.alignItems = 'center';
        searchContainer.innerHTML = `
            <div style="display: flex; gap: 10px; flex: 1; max-width: 700px; flex-wrap: wrap;">
                <input type="text" id="invoices-search-input" placeholder="Search by Order ID or Status..." style="padding: 8px; border-radius: 4px; border: 1px solid #ccc; font-size: 0.9em; flex: 1; min-width: 200px;">
                <input type="date" id="invoices-start-date" style="padding: 8px; border-radius: 4px; border: 1px solid #ccc; font-size: 0.9em;">
                <input type="date" id="invoices-end-date" style="padding: 8px; border-radius: 4px; border: 1px solid #ccc; font-size: 0.9em;">
                <select id="invoices-sort" style="padding: 8px; border-radius: 4px; border: 1px solid #ccc; font-size: 0.9em; cursor: pointer;">
                    <option value="created_at-desc">Date (Newest First)</option>
                    <option value="created_at-asc">Date (Oldest First)</option>
                    <option value="amount-desc">Amount (Highest First)</option>
                    <option value="amount-asc">Amount (Lowest First)</option>
                    <option value="status-asc">Status</option>
                </select>
            </div>
            <button id="invoices-export-btn" class="btn btn-secondary" style="padding: 8px 15px; border-radius: 4px; border: none; background-color: #6c757d; color: white; cursor: pointer; font-weight: bold;">Export to CSV</button>
        `;
        invoicesContainer.parentNode.insertBefore(searchContainer, invoicesContainer);

        let searchTimeout;
        document.getElementById('invoices-search-input').addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                fetchAndRenderInvoices(1);
            }, 300); // 300ms debounce
        });

        document.getElementById('invoices-sort').addEventListener('change', () => {
            fetchAndRenderInvoices(1);
        });

        document.getElementById('invoices-start-date').addEventListener('change', (e) => {
            const startDate = e.target.value;
            const endDateInput = document.getElementById('invoices-end-date');
            
            if (startDate) {
                endDateInput.min = startDate;
                if (endDateInput.value && endDateInput.value < startDate) {
                    endDateInput.value = '';
                }
            } else {
                endDateInput.min = '';
            }
            fetchAndRenderInvoices(1);
        });

        document.getElementById('invoices-end-date').addEventListener('change', () => {
            fetchAndRenderInvoices(1);
        });

        document.getElementById('invoices-export-btn').addEventListener('click', async (e) => {
            const btn = e.target;
            const originalText = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Exporting...';

            const searchInput = document.getElementById('invoices-search-input');
            const searchQuery = searchInput ? searchInput.value.trim() : '';

            const startDateInput = document.getElementById('invoices-start-date');
            const startDate = startDateInput ? startDateInput.value : '';

            const endDateInput = document.getElementById('invoices-end-date');
            const endDate = endDateInput ? endDateInput.value : '';

            const sortSelect = document.getElementById('invoices-sort');
            let sortBy = 'created_at';
            let sortOrder = 'desc';

            if (sortSelect) {
                const value = sortSelect.value;
                const lastDashIndex = value.lastIndexOf('-');
                sortBy = value.substring(0, lastDashIndex);
                sortOrder = value.substring(lastDashIndex + 1);
            }

            try {
                const blob = await apiFetch(`/api/orders/history/export?search=${encodeURIComponent(searchQuery)}&sortBy=${sortBy}&sortOrder=${sortOrder}&startDate=${startDate}&endDate=${endDate}`, {
                    method: 'GET',
                    responseType: 'blob'
                });

                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = 'invoices.csv';
                document.body.appendChild(a);
                a.click();
                
                window.URL.revokeObjectURL(url);
                a.remove();
            } catch (error) {
                showNotification(`Failed to export data: ${error.message}`, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        });
    }

    // Fetch the first page of invoices
    fetchAndRenderInvoices(1);
}

/**
 * Fetches a specific page of invoices and renders them along with pagination controls.
 * @param {number} page - The page number to fetch.
 */
async function fetchAndRenderInvoices(page = 1) {
    if (!invoicesContainer) return;

    const searchInput = document.getElementById('invoices-search-input');
    const searchQuery = searchInput ? searchInput.value.trim() : '';

    const startDateInput = document.getElementById('invoices-start-date');
    const startDate = startDateInput ? startDateInput.value : '';

    const endDateInput = document.getElementById('invoices-end-date');
    const endDate = endDateInput ? endDateInput.value : '';

    const sortSelect = document.getElementById('invoices-sort');
    let sortBy = 'created_at';
    let sortOrder = 'desc';

    if (sortSelect) {
        const value = sortSelect.value;
        const lastDashIndex = value.lastIndexOf('-');
        sortBy = value.substring(0, lastDashIndex);
        sortOrder = value.substring(lastDashIndex + 1);
    }

    invoicesContainer.innerHTML = '<p>Loading your order history...</p>';
    if (paginationContainer) paginationContainer.innerHTML = ''; // Clear old controls

    try {
        // Append page and a desired limit to the fetch URL
        const { data: orders, pagination } = await apiFetch(`/api/orders/history?page=${page}&limit=10&search=${encodeURIComponent(searchQuery)}&sortBy=${sortBy}&sortOrder=${sortOrder}&startDate=${startDate}&endDate=${endDate}`);

        renderInvoicesTable(orders, invoicesContainer);

        // Only render pagination if there's more than one page
        if (paginationContainer && pagination.totalPages > 1) {
            renderPaginationControls(pagination, paginationContainer);
        }
        
        // Auto-scroll to the top of the table for better UX after loading the new page
        const yOffset = invoicesContainer.getBoundingClientRect().top + window.scrollY - 50;
        window.scrollTo({ top: Math.max(0, yOffset), behavior: 'smooth' });

    } catch (error) {
        console.error('Error fetching invoices:', error);
        invoicesContainer.innerHTML = `<p style="color: red;">Could not load your order history. Please try again later.</p>`;
        showNotification(error.message, 'error');
    }
}

/**
 * Renders the table of orders into the specified container.
 * @param {Array<Object>} orders - The array of order objects from the API.
 * @param {HTMLElement} container - The container element to render into.
 */
function renderInvoicesTable(orders, container) {
    if (!orders || orders.length === 0) {
        const isSearch = document.getElementById('invoices-search-input')?.value.trim();
        container.innerHTML = isSearch ? '<p>No orders found matching your search.</p>' : '<p>You have not made any purchases yet.</p>';
        return;
    }

    // Create a table to display the invoice data
    const table = document.createElement('table');
    table.className = 'invoices-table'; // For styling
    table.innerHTML = `
        <thead>
            <tr>
                <th>Order ID</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Actions</th>
            </tr>
        </thead>
    `;

    const tbody = document.createElement('tbody');
    orders.forEach(order => {
        const tr = document.createElement('tr');
        const orderDate = new Date(order.created_at).toLocaleDateString();
        const amountFormatted = new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: order.currency
        }).format(order.amount / 100);

        // Apply a specific red badge style if the order failed
        let statusStyle = '';
        let displayStatus = order.status;
        if (order.status === 'failed') {
            statusStyle = 'background-color: #dc3545; color: white; padding: 4px 8px; border-radius: 12px; font-weight: bold; font-size: 0.85em; text-transform: capitalize;';
            displayStatus = 'Failed ✖';
        }

        tr.innerHTML = `
            <td>#${order.id.toString().padStart(6, '0')}</td>
            <td>${orderDate}</td>
            <td>${amountFormatted}</td>
            <td><span class="status status--${order.status}" style="${statusStyle}">${displayStatus}</span></td>
            <td class="actions-cell">
                <a href="/api/orders/invoice/${order.id}/pdf" class="btn-download" title="Download Invoice">Download</a>
            </td>
        `;

        // Only allow cancellation if the order was successfully completed
        if (order.status === 'succeeded') {
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn-cancel';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.marginLeft = '10px';
            cancelBtn.addEventListener('click', () => handleCancelOrder(order.id));
            tr.querySelector('.actions-cell').appendChild(cancelBtn);
        }

        // Add a retry button for failed orders
        if (order.status === 'failed') {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'btn-retry';
            retryBtn.textContent = 'Retry Payment';
            retryBtn.style.marginLeft = '10px';
            retryBtn.addEventListener('click', () => handleRetryPayment(order.id));
            tr.querySelector('.actions-cell').appendChild(retryBtn);
        }

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.innerHTML = ''; // Clear the "Loading..." message
    container.appendChild(table);
}

/**
 * Handles the cancellation and refund of an order.
 * @param {number} orderId - The ID of the order to cancel.
 */
async function handleCancelOrder(orderId) {
    if (!confirm('Are you sure you want to cancel this order? This will process a full refund.')) {
        return;
    }

    try {
        await apiFetch(`/api/orders/${orderId}/cancel`, {
            method: 'POST',
        });

        showNotification('Order cancelled and refunded successfully.', 'success');
        
        // Re-fetch the current page of invoices to instantly show the "refunded" status
        const currentPageMatch = document.querySelector('.pagination-indicator')?.textContent.match(/Page (\d+)/);
        const currentPage = currentPageMatch ? parseInt(currentPageMatch[1], 10) : 1;
        fetchAndRenderInvoices(currentPage);

    } catch (error) {
        console.error('Cancel order error:', error);
        showNotification(`Error: ${error.message}`, 'error');
    }
}

/**
 * Handles retrying a failed payment.
 * @param {number} orderId - The ID of the order to retry.
 */
function handleRetryPayment(orderId) {
    // Redirect the user to the checkout page with the order ID to try again
    window.location.href = `/checkout?retryOrder=${orderId}`;
}

/**
 * Renders pagination controls (Previous/Next buttons and page indicator).
 * @param {object} pagination - The pagination object from the API.
 * @param {HTMLElement} container - The container for the controls.
 */
function renderPaginationControls(pagination, container) {
    const { currentPage, totalPages } = pagination;

    const prevButton = document.createElement('button');
    prevButton.textContent = '« Previous';
    prevButton.disabled = currentPage <= 1;
    prevButton.className = 'pagination-btn';
    prevButton.addEventListener('click', () => fetchAndRenderInvoices(currentPage - 1));

    const pageIndicator = document.createElement('span');
    pageIndicator.textContent = `Page ${currentPage} of ${totalPages}`;
    pageIndicator.className = 'pagination-indicator';

    const nextButton = document.createElement('button');
    nextButton.textContent = 'Next »';
    nextButton.disabled = currentPage >= totalPages;
    nextButton.className = 'pagination-btn';
    nextButton.addEventListener('click', () => fetchAndRenderInvoices(currentPage + 1));

    container.append(prevButton, pageIndicator, nextButton);
}