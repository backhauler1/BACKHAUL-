import { showNotification } from './notifications.js';

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

    // Fetch the first page of invoices
    fetchAndRenderInvoices(1);
}

/**
 * Fetches a specific page of invoices and renders them along with pagination controls.
 * @param {number} page - The page number to fetch.
 */
async function fetchAndRenderInvoices(page = 1) {
    if (!invoicesContainer) return;

    invoicesContainer.innerHTML = '<p>Loading your order history...</p>';
    if (paginationContainer) paginationContainer.innerHTML = ''; // Clear old controls

    try {
        // Append page and a desired limit to the fetch URL
        const response = await fetch(`/api/orders/history?page=${page}&limit=10`);

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to fetch order history.');
        }

        const { data: orders, pagination } = await response.json();

        renderInvoicesTable(orders, invoicesContainer);

        // Only render pagination if there's more than one page
        if (paginationContainer && pagination.totalPages > 1) {
            renderPaginationControls(pagination, paginationContainer);
        }

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
        // If it's the first page and there are no orders, show the message.
        if (container.querySelector('p')) { // Check if it's still in the "Loading" state
            container.innerHTML = '<p>You have not made any purchases yet.</p>';
        }
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
        const amountInDollars = (order.amount / 100).toFixed(2);

        tr.innerHTML = `
            <td>#${order.id.toString().padStart(6, '0')}</td>
            <td>${orderDate}</td>
            <td>$${amountInDollars} ${order.currency.toUpperCase()}</td>
            <td><span class="status status--${order.status}">${order.status}</span></td>
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
        const response = await fetch(`/api/orders/${orderId}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to cancel order.');
        }

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