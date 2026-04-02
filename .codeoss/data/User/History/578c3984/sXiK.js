import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

/**
 * Initializes the My Trucks page by fetching and rendering the user's vehicles.
 */
export async function initializeMyTrucksPage() {
    const container = document.getElementById('my-trucks-container');
    if (!container) return;

    // Add "Add New Truck" section if it doesn't exist
    if (!document.getElementById('add-truck-section')) {
        const addSection = document.createElement('div');
        addSection.id = 'add-truck-section';
        addSection.style.marginBottom = '20px';
        
        addSection.innerHTML = `
            <button id="toggle-add-truck-btn" class="btn btn-primary" style="margin-bottom: 15px; padding: 8px 15px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">+ Add New Truck</button>
            <div id="add-truck-form-container" style="display: none; border: 1px solid #e0e0e0; padding: 20px; border-radius: 8px; background-color: #f9f9fc; margin-bottom: 20px;">
                <h3 style="margin-top: 0; margin-bottom: 15px;">Register New Truck</h3>
                <form id="inline-add-truck-form">
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Truck Name *</label>
                        <input type="text" name="truckName" required style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Type *</label>
                        <select name="truckType" required style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                            <option value="flatbed">Flatbed</option>
                            <option value="dry_van">Dry van</option>
                            <option value="reefer">Reefer</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Capacity (lbs)</label>
                        <input type="number" name="capacity" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Home Base *</label>
                        <input type="text" name="homeBase" required placeholder="e.g., Chicago, IL" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Thumbnail (Optional)</label>
                        <input type="file" name="thumbnail" accept="image/jpeg, image/png, image/gif, image/webp" style="width: 100%; font-size: 0.9em;">
                    </div>
                    <div style="display: flex; gap: 10px;">
                        <button type="submit" class="btn btn-primary" style="padding: 8px 15px; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">Register Truck</button>
                        <button type="button" id="cancel-add-truck-btn" class="btn btn-secondary" style="padding: 8px 15px; background-color: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
                    </div>
                </form>
            </div>
        `;
        container.parentNode.insertBefore(addSection, container);

        const toggleBtn = document.getElementById('toggle-add-truck-btn');
        const formContainer = document.getElementById('add-truck-form-container');
        const cancelBtn = document.getElementById('cancel-add-truck-btn');
        const addForm = document.getElementById('inline-add-truck-form');

        toggleBtn.addEventListener('click', () => {
            formContainer.style.display = 'block';
            toggleBtn.style.display = 'none';
        });

        cancelBtn.addEventListener('click', () => {
            formContainer.style.display = 'none';
            toggleBtn.style.display = 'block';
            addForm.reset();
        });

        addForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = addForm.querySelector('button[type="submit"]');
            const originalText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Registering...';

            const formData = new FormData(addForm);
            
            // Safely handle the optional capacity field so it doesn't fail backend Zod coercion if left blank
            if (!formData.get('capacity')) {
                formData.delete('capacity');
            }

            try {
                await apiFetch('/api/trucks/register', {
                    method: 'POST',
                    body: formData
                });
                showNotification('Truck registered successfully!', 'success');
                
                // Reset and close the form panel
                formContainer.style.display = 'none';
                toggleBtn.style.display = 'block';
                addForm.reset();
                
                // Re-render the truck list starting at page 1 to see the new addition
                loadMyTrucks(container, 1); 
            } catch (error) {
                showNotification(`Registration failed: ${error.message}`, 'error');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }

    // Add sort dropdown if it doesn't exist
    if (!document.getElementById('my-trucks-sort-container')) {
        const sortContainer = document.createElement('div');
        sortContainer.id = 'my-trucks-sort-container';
        sortContainer.style.marginBottom = '20px';
        sortContainer.style.display = 'flex';
        sortContainer.style.justifyContent = 'flex-end';
        sortContainer.innerHTML = `
            <select id="my-trucks-sort" style="padding: 8px; border-radius: 4px; border: 1px solid #ccc; font-size: 0.9em; cursor: pointer;">
                <option value="created_at-desc">Newest First</option>
                <option value="created_at-asc">Oldest First</option>
                <option value="name-asc">Name (A-Z)</option>
                <option value="name-desc">Name (Z-A)</option>
                <option value="is_available-desc">Available First</option>
                <option value="is_available-asc">Unavailable First</option>
            </select>
        `;
        container.parentNode.insertBefore(sortContainer, container);

        document.getElementById('my-trucks-sort').addEventListener('change', () => {
            loadMyTrucks(container, 1);
        });
    }

    await loadMyTrucks(container, 1);
}

async function loadMyTrucks(container, page = 1) {
    container.innerHTML = '<p class="text-secondary">Loading your trucks...</p>';

    const sortSelect = document.getElementById('my-trucks-sort');
    let sortBy = 'created_at';
    let sortOrder = 'desc';

    if (sortSelect) {
        const value = sortSelect.value;
        const lastDashIndex = value.lastIndexOf('-');
        sortBy = value.substring(0, lastDashIndex);
        sortOrder = value.substring(lastDashIndex + 1);
    }

    try {
        const response = await apiFetch(`/api/trucks/me?page=${page}&limit=12&sortBy=${sortBy}&sortOrder=${sortOrder}`);
        const trucks = response.data;
        const pagination = response.pagination;

        if (!trucks || trucks.length === 0) {
            container.innerHTML = page > 1 ? '<p>No more trucks found.</p>' : '<p>You have not registered any trucks yet.</p>';
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
            const thumbnail = truck.thumbnail_url || ''; // Replaced placeholder
            
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
                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                    <button class="btn btn-outline-primary toggle-availability-btn" data-id="${truck.id}" data-available="${truck.is_available}" style="flex: 1 1 100%; padding: 8px;">
                        Mark ${truck.is_available ? 'Unavailable' : 'Available'}
                    </button>
                    <button class="btn btn-outline-secondary edit-truck-btn" data-id="${truck.id}" style="flex: 1; padding: 8px;">Edit</button>
                    <button class="btn btn-outline-danger delete-truck-btn" data-id="${truck.id}" style="flex: 1; padding: 8px;">Delete</button>
                </div>
            `;

            grid.appendChild(card);
        });

        container.appendChild(grid);

        // --- Pagination Controls ---
        if (pagination && pagination.totalPages > 1) {
            const paginationDiv = document.createElement('div');
            paginationDiv.style.cssText = 'margin-top: 20px; display: flex; justify-content: center; align-items: center; gap: 15px;';

            const prevBtn = document.createElement('button');
            prevBtn.textContent = '« Previous';
            prevBtn.disabled = pagination.currentPage <= 1;
            prevBtn.className = 'btn btn-outline-secondary';
            prevBtn.addEventListener('click', () => loadMyTrucks(container, pagination.currentPage - 1));

            const pageInfo = document.createElement('span');
            pageInfo.textContent = `Page ${pagination.currentPage} of ${pagination.totalPages}`;

            const nextBtn = document.createElement('button');
            nextBtn.textContent = 'Next »';
            nextBtn.disabled = pagination.currentPage >= pagination.totalPages;
            nextBtn.className = 'btn btn-outline-secondary';
            nextBtn.addEventListener('click', () => loadMyTrucks(container, pagination.currentPage + 1));

            paginationDiv.append(prevBtn, pageInfo, nextBtn);
            container.appendChild(paginationDiv);
        }

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
                    await loadMyTrucks(container, page); // Refresh current page to show new status
                } catch (error) {
                    showNotification(`Failed to update truck: ${error.message}`, 'error');
                    e.target.disabled = false;
                    e.target.textContent = originalText;
                }
            });
        });

        container.querySelectorAll('.edit-truck-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const truckId = e.target.dataset.id;
                const truck = trucks.find(t => t.id == truckId);
                const card = e.target.closest('.truck-card');
                
                renderEditForm(card, truck, container, page);
            });
        });

        container.querySelectorAll('.delete-truck-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if (!confirm('Are you sure you want to delete this truck? This action cannot be undone.')) return;
                try {
                    await apiFetch(`/api/trucks/${e.target.dataset.id}`, { method: 'DELETE' });
                    showNotification('Truck deleted successfully.', 'success');
                    await loadMyTrucks(container, page); // Refresh current page to remove card
                } catch (error) {
                    showNotification(`Failed to delete truck: ${error.message}`, 'error');
                }
            });
        });
    } catch (error) {
        container.innerHTML = `<p style="color: red;">Failed to load your trucks: ${error.message}</p>`;
    }
}

function renderEditForm(card, truck, container, page) {
    card.innerHTML = `
        <form class="edit-truck-form" data-id="${truck.id}">
            <div style="margin-bottom: 10px;">
                <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Truck Name</label>
                <input type="text" name="truckName" value="${truck.name}" required style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
            </div>
            <div style="margin-bottom: 10px;">
                <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Type</label>
                <select name="truckType" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                    <option value="flatbed" ${truck.type === 'flatbed' ? 'selected' : ''}>Flatbed</option>
                    <option value="dry_van" ${truck.type === 'dry_van' ? 'selected' : ''}>Dry van</option>
                    <option value="reefer" ${truck.type === 'reefer' ? 'selected' : ''}>Reefer</option>
                    <option value="other" ${truck.type === 'other' ? 'selected' : ''}>Other</option>
                </select>
            </div>
            <div style="margin-bottom: 10px;">
                <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Capacity (lbs)</label>
                <input type="number" name="capacity" value="${truck.capacity || ''}" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
            </div>
            <div style="margin-bottom: 10px;">
                <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Home Base</label>
                <input type="text" name="homeBase" value="${truck.home_base}" required style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
            </div>
            <div style="margin-bottom: 15px;">
                <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">New Thumbnail (Optional)</label>
                <input type="file" name="thumbnail" accept="image/jpeg, image/png, image/gif, image/webp" style="width: 100%; font-size: 0.9em;">
            </div>
            <div style="display: flex; gap: 10px;">
                <button type="submit" class="btn btn-primary" style="flex: 1; padding: 8px; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">Save</button>
                <button type="button" class="btn btn-secondary cancel-edit-btn" style="flex: 1; padding: 8px; background-color: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
            </div>
        </form>
    `;

    card.querySelector('.cancel-edit-btn').addEventListener('click', () => {
        loadMyTrucks(container, page); // Re-renders the list to return to view mode
    });

    card.querySelector('.edit-truck-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';

        const formData = new FormData(form);
        
        // Safely handle the optional capacity field so it doesn't fail backend Zod coercion if left blank
        if (!formData.get('capacity')) {
            formData.delete('capacity');
        }

        try {
            await apiFetch(`/api/trucks/${truck.id}`, {
                method: 'PUT',
                body: formData
            });
            showNotification('Truck updated successfully.', 'success');
            loadMyTrucks(container, page); // Refresh to display the new info
        } catch (error) {
            showNotification(`Failed to update truck: ${error.message}`, 'error');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save';
        }
    });
}