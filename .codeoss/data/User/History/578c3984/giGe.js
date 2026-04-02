import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

/**
 * Initializes the My Trucks page by fetching and rendering the user's vehicles.
 */
export async function initializeMyTrucksPage() {
    const container = document.getElementById('my-trucks-container');
    if (!container) return;

    await loadMyTrucks(container);
}

async function loadMyTrucks(container) {
    container.innerHTML = '<p class="text-secondary">Loading your trucks...</p>';

    try {
        const response = await apiFetch('/api/trucks/me');
        const trucks = response.data;

        if (!trucks || trucks.length === 0) {
            container.innerHTML = '<p>You have not registered any trucks yet.</p>';
            return;
        }

        container.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'trucks-grid';
        // Basic styling that you can later extract to your style.css
        grid.style.display = 'grid';
        grid.style.gap = '20px';
        grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(300px, 1fr))';

        trucks.forEach(truck => {
            const card = document.createElement('div');
            card.className = 'truck-card';
            card.style.border = '1px solid #e0e0e0';
            card.style.padding = '15px';
            card.style.borderRadius = '8px';
            card.style.backgroundColor = '#fff';
            card.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)';

            const statusText = truck.is_available ? 'Available' : 'Unavailable';
            const statusColor = truck.is_available ? '#28a745' : '#dc3545';
            const thumbnail = truck.thumbnail_url || 'https://via.placeholder.com/300x200?text=No+Image';
            
            // Format the truck type text nicely (e.g., 'dry_van' -> 'Dry van')
            const typeFormatted = truck.type.replace('_', ' ');

            card.innerHTML = `
                <img src="${thumbnail}" alt="${truck.name}" style="width: 100%; height: 200px; object-fit: cover; border-radius: 4px; margin-bottom: 15px;">
                <h3 style="margin-top: 0; margin-bottom: 10px;">${truck.name}</h3>
                <div style="font-size: 0.9em; color: #555; margin-bottom: 15px;">
                    <p style="margin: 5px 0;"><strong>Type:</strong> <span style="text-transform: capitalize;">${typeFormatted}</span></p>
                    <p style="margin: 5px 0;"><strong>Capacity:</strong> ${truck.capacity ? truck.capacity + ' lbs' : 'N/A'}</p>
                    <p style="margin: 5px 0;"><strong>Home Base:</strong> ${truck.home_base}</p>
                    <p style="margin: 5px 0;"><strong>Status:</strong> <span style="color: ${statusColor}; font-weight: bold;">${statusText}</span></p>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-outline-primary toggle-availability-btn" data-id="${truck.id}" data-available="${truck.is_available}" style="flex: 1; padding: 8px;">
                        Mark ${truck.is_available ? 'Unavailable' : 'Available'}
                    </button>
                    <button class="btn btn-outline-danger delete-truck-btn" data-id="${truck.id}" style="padding: 8px 15px;">Delete</button>
                </div>
            `;

            grid.appendChild(card);
        });

        container.appendChild(grid);

        // --- Event Listeners for Actions ---
        container.querySelectorAll('.toggle-availability-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const truckId = e.target.dataset.id;
                const currentStatus = e.target.dataset.available === 'true';
                const originalText = e.target.textContent;
                
                e.target.disabled = true;
                e.target.textContent = 'Updating...';

                try {
                    await apiFetch(`/api/trucks/${truckId}/availability`, { method: 'PATCH', body: { isAvailable: !currentStatus } });
                    showNotification('Truck availability updated successfully.', 'success');
                    await loadMyTrucks(container); // Refresh to show new status
                } catch (error) {
                    showNotification(`Failed to update truck: ${error.message}`, 'error');
                    e.target.disabled = false;
                    e.target.textContent = originalText;
                }
            });
        });

        container.querySelectorAll('.delete-truck-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if (!confirm('Are you sure you want to delete this truck? This action cannot be undone.')) return;
                try {
                    await apiFetch(`/api/trucks/${e.target.dataset.id}`, { method: 'DELETE' });
                    showNotification('Truck deleted successfully.', 'success');
                    await loadMyTrucks(container); // Refresh to remove card
                } catch (error) {
                    showNotification(`Failed to delete truck: ${error.message}`, 'error');
                }
            });
        });
    } catch (error) {
        container.innerHTML = `<p style="color: red;">Failed to load your trucks: ${error.message}</p>`;
    }
}