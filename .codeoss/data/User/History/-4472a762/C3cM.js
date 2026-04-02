import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

const LIMIT = 10;

/**
 * Initializes the Order History component.
 * @param {string} containerId - The ID of the DOM element to render into.
 */
export async function initOrderHistory(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    await fetchAndRenderOrders(container, 1);
}

async function fetchAndRenderOrders(container, page) {
    container.innerHTML = '<p style="color: #666;">Loading your orders...</p>';
    
    try {
        const response = await apiFetch(`/api/orders/history?page=${page}&limit=${LIMIT}`);
        renderOrders(container, response);
    } catch (error) {
        console.error('Failed to load orders:', error);
        container.innerHTML = `<p style="color: #dc3545;">Failed to load orders: ${error.message}</p>`;
    }
}

function renderOrders(container, response) {
    const { data: orders, pagination } = response;

    if (!orders || orders.length === 0) {
        container.innerHTML = '<p style="color: #666; font-style: italic;">You have no past orders.</p>';
        return;
    }

    let html = `
        <table style="width: 100%; border-collapse: collapse; text-align: left; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden;">
            <thead style="background-color: #f8f9fa; border-bottom: 2px solid #dee2e6;">
                <tr>
                    <th style="padding: 12px 15px; color: #495057;">Order ID</th>
                    <th style="padding: 12px 15px; color: #495057;">Date</th>
                    <th style="padding: 12px 15px; color: #495057;">Total</th>
                    <th style="padding: 12px 15px; color: #495057;">Status</th>
                    <th style="padding: 12px 15px; color: #495057; text-align: right;">Actions</th>
                </tr>
            </thead>
            <tbody>
    `;

    orders.forEach(order => {
        const date = new Date(order.created_at).toLocaleDateString();
        const amount = `$${(order.amount / 100).toFixed(2)}`;
        
        // Style the status dynamically
        let statusColor = '#6c757d'; // Default gray
        if (order.status === 'succeeded') statusColor = '#28a745'; // Green
        if (order.status === 'refunded') statusColor = '#ffc107'; // Yellow
        if (order.status === 'failed') statusColor = '#dc3545'; // Red

        html += `
            <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 12px 15px; font-family: monospace; color: #555;">#${order.id}</td>
                <td style="padding: 12px 15px;">${date}</td>
                <td style="padding: 12px 15px; font-weight: bold;">${amount}</td>
                <td style="padding: 12px 15px; color: ${statusColor}; text-transform: capitalize; font-weight: bold;">${order.status}</td>
                <td style="padding: 12px 15px; text-align: right;">
                    <button class="download-invoice-btn" data-id="${order.id}" style="padding: 6px 12px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; transition: background-color 0.2s;">
                        ↓ PDF Invoice
                    </button>
                </td>
            </tr>
        `;
    });

    html += `</tbody></table>`;

    // Add Pagination Controls
    if (pagination.totalPages > 1) {
        html += `<div style="margin-top: 20px; display: flex; gap: 15px; justify-content: center; align-items: center;">`;
        if (pagination.currentPage > 1) {
            html += `<button class="page-btn" data-page="${pagination.currentPage - 1}" style="padding: 8px 16px; cursor: pointer;">Previous</button>`;
        }
        html += `<span style="color: #666;">Page ${pagination.currentPage} of ${pagination.totalPages}</span>`;
        if (pagination.currentPage < pagination.totalPages) {
            html += `<button class="page-btn" data-page="${pagination.currentPage + 1}" style="padding: 8px 16px; cursor: pointer;">Next</button>`;
        }
        html += `</div>`;
    }

    container.innerHTML = html;

    // Attach event listeners for downloading invoices
    container.querySelectorAll('.download-invoice-btn').forEach(btn => {
        btn.addEventListener('click', () => downloadInvoice(btn.getAttribute('data-id'), btn));
    });

    // Attach event listeners for pagination buttons
    container.querySelectorAll('.page-btn').forEach(btn => {
        btn.addEventListener('click', (e) => fetchAndRenderOrders(container, parseInt(e.target.getAttribute('data-page'), 10)));
    });
}

async function downloadInvoice(orderId, buttonElement) {
    const originalText = buttonElement.textContent;
    buttonElement.textContent = 'Downloading...';
    buttonElement.disabled = true;

    try {
        // We leverage apiFetch's built-in blob support to handle the binary PDF data securely
        const blob = await apiFetch(`/api/orders/invoice/${orderId}/pdf`, { responseType: 'blob' });
        
        // Create a temporary hidden link to trigger the browser's download prompt
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `invoice-${orderId.toString().padStart(6, '0')}.pdf`;
        document.body.appendChild(a);
        a.click();
        
        // Cleanup the DOM and memory
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch (error) {
        showNotification('Failed to download invoice.', 'error');
    } finally {
        buttonElement.textContent = originalText;
        buttonElement.disabled = false;
    }
}