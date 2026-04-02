import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

export async function loadBids(loadId, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<p>Loading bids...</p>';

    try {
        const response = await apiFetch(`/api/loads/${loadId}/bids`);
        const bids = response.data;

        if (!bids || bids.length === 0) {
            container.innerHTML = '<p>No bids placed yet.</p>';
            return;
        }

        const list = document.createElement('ul');
        list.className = 'bids-list';
        
        bids.forEach(bid => {
            const li = document.createElement('li');
            li.className = 'bid-item';
            li.innerHTML = `
                <div class="bid-details">
                    <strong>Driver:</strong> ${bid.driver_name} (Rating: ${parseFloat(bid.driver_rating).toFixed(1)} ★)<br>
                    <strong>Bid Amount:</strong> $${bid.bid_amount}<br>
                    <strong>Notes:</strong> ${bid.notes || 'None'}<br>
                    <strong>Date:</strong> ${new Date(bid.created_at).toLocaleString()}<br>
                    <strong>Status:</strong> <span class="badge ${bid.status}">${bid.status}</span>
                </div>
            `;
            if (bid.status === 'pending') {
                const acceptBtn = document.createElement('button');
                acceptBtn.textContent = 'Accept Bid';
                acceptBtn.className = 'btn btn-success btn-sm mt-2';
                acceptBtn.addEventListener('click', async () => {
                    if (!confirm('Are you sure you want to accept this bid? This will assign the driver to the load and reject all other bids.')) return;
                    try {
                        await apiFetch(`/api/loads/${loadId}/bids/${bid.id}/accept`, { method: 'POST' });
                        showNotification('Bid accepted successfully!', 'success');
                        loadBids(loadId, containerId); // Reload the list
                    } catch (error) {
                        showNotification(`Failed to accept bid: ${error.message}`, 'error');
                    }
                });
                li.appendChild(acceptBtn);
            }
            list.appendChild(li);
        });

        container.innerHTML = '';
        container.appendChild(list);
    } catch (error) {
        container.innerHTML = `<p style="color: red;">Failed to load bids: ${error.message}</p>`;
    }
}