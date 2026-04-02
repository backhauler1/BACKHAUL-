import { showNotification } from './notifications.js';

/**
 * Initializes the invoices page by fetching and rendering the user's order history.
 */
export async function initializeInvoicesPage() {
    const invoicesContainer = document.getElementById('invoices-list-container');
    if (!invoicesContainer) {
        // This page doesn't have the container, so do nothing.
        return;
    }

    invoicesContainer.innerHTML = '<p>Loading your order history...</p>';

    try {
        // This assumes cookies (for the auth token) are sent automatically by the browser.
        const response = await fetch('/api/orders/history');

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to fetch order history.');
        }

        const { data: orders } = await response.json();

        renderInvoices(orders, invoicesContainer);

    } catch (error) {
        console.error('Error fetching invoices:', error);
        invoicesContainer.innerHTML = `<p style="color: red;">Could not load your order history. Please try again later.</p>`;
        showNotification(error.message, 'error');
    }
}

/**
 * Renders the list of orders into the specified container.
 * @param {Array<Object>} orders - The array of order objects from the API.
 * @param {HTMLElement} container - The container element to render into.
 */
function renderInvoices(orders, container) {
    if (!orders || orders.length === 0) {
        container.innerHTML = '<p>You have not made any purchases yet.</p>';
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
            </tr>
        </thead>
    `;

    const tbody = document.createElement('tbody');
    orders.forEach(order => {
        const tr = document.createElement('tr');
        
        const orderDate = new Date(order.created_at).toLocaleDateString();
        const amountInDollars = (order.amount / 100).toFixed(2);

        tr.innerHTML = `
            <td>#${order.id}</td>
            <td>${orderDate}</td>
            <td>$${amountInDollars} ${order.currency.toUpperCase()}</td>
            <td><span class="status status--${order.status}">${order.status}</span></td>
        `;
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);
}