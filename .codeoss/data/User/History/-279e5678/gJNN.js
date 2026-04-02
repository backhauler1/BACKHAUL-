import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

/**
 * Initializes the My Posted Loads page by fetching and rendering the user's loads,
 * and injecting an inline form to post new loads.
 * @param {string} containerId - The ID of the container where loads should be listed.
 */
export async function initializeMyPostedLoadsPage(containerId = 'my-posted-loads-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Add "Post New Load" section if it doesn't exist
    if (!document.getElementById('post-load-section')) {
        const addSection = document.createElement('div');
        addSection.id = 'post-load-section';
        addSection.style.marginBottom = '20px';
        
        addSection.innerHTML = `
            <button id="toggle-post-load-btn" class="btn btn-primary" style="margin-bottom: 15px; padding: 8px 15px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">+ Post New Load</button>
            <div id="post-load-form-container" style="display: none; border: 1px solid #e0e0e0; padding: 20px; border-radius: 8px; background-color: #f9f9fc; margin-bottom: 20px;">
                <h3 style="margin-top: 0; margin-bottom: 15px;">Post a New Load</h3>
                <form id="inline-post-load-form">
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Title *</label>
                        <input type="text" name="title" required style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" placeholder="e.g., Heavy Machinery Transport">
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Description</label>
                        <textarea name="description" rows="3" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" placeholder="Details about the cargo..."></textarea>
                    </div>
                    <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                        <div style="flex: 1;">
                            <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Pickup Address *</label>
                            <input type="text" name="pickupAddress" required style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" placeholder="City, State, Zip">
                        </div>
                        <div style="flex: 1;">
                            <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Delivery Address *</label>
                            <input type="text" name="deliveryAddress" required style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" placeholder="City, State, Zip">
                        </div>
                    </div>
                    <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                        <div style="flex: 1;">
                            <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Pickup Date</label>
                            <input type="date" name="pickupDate" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                        </div>
                        <div style="flex: 1;">
                            <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Delivery Date</label>
                            <input type="date" name="deliveryDate" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                        </div>
                    </div>
                    <div style="display: flex; gap: 10px; margin-bottom: 15px;">
                        <div style="flex: 1;">
                            <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Required Vehicle</label>
                            <select name="requiredVehicleClass" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                                <option value="">Any</option>
                                <option value="flatbed">Flatbed</option>
                                <option value="dry_van">Dry van</option>
                                <option value="reefer">Reefer</option>
                                <option value="other">Other</option>
                            </select>
                        </div>
                        <div style="flex: 1;">
                            <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Weight (lbs)</label>
                            <input type="number" name="weight" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" min="1">
                        </div>
                        <div style="flex: 1;">
                            <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Rate ($)</label>
                            <input type="number" name="rate" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" min="1" step="0.01">
                        </div>
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">BOL Document (Optional)</label>
                        <input type="file" name="bolDocument" accept="application/pdf, image/jpeg, image/png" style="width: 100%; font-size: 0.9em;">
                    </div>
                    <div style="display: flex; gap: 10px;">
                        <button type="submit" class="btn btn-primary" style="padding: 8px 15px; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">Post Load</button>
                        <button type="button" id="cancel-post-load-btn" class="btn btn-secondary" style="padding: 8px 15px; background-color: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
                    </div>
                </form>
            </div>
        `;
        container.parentNode.insertBefore(addSection, container);

        const toggleBtn = document.getElementById('toggle-post-load-btn');
        const formContainer = document.getElementById('post-load-form-container');
        const cancelBtn = document.getElementById('cancel-post-load-btn');
        const postForm = document.getElementById('inline-post-load-form');

        // Enforce Date Constraints (Cannot pick past dates, end date >= start date)
        const pickupDateInput = postForm.querySelector('input[name="pickupDate"]');
        const deliveryDateInput = postForm.querySelector('input[name="deliveryDate"]');
        
        const today = new Date();
        const localDateString = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
        
        if (pickupDateInput) pickupDateInput.min = localDateString;
        if (deliveryDateInput) deliveryDateInput.min = localDateString;

        if (pickupDateInput && deliveryDateInput) {
            pickupDateInput.addEventListener('change', () => {
                if (pickupDateInput.value) {
                    deliveryDateInput.min = pickupDateInput.value;
                    if (deliveryDateInput.value && deliveryDateInput.value < pickupDateInput.value) {
                        deliveryDateInput.value = ''; // Reset invalid end date
                    }
                } else {
                    deliveryDateInput.min = localDateString;
                }
            });
        }

        // Toggle Handlers
        toggleBtn.addEventListener('click', () => {
            formContainer.style.display = 'block';
            toggleBtn.style.display = 'none';
        });

        cancelBtn.addEventListener('click', () => {
            formContainer.style.display = 'none';
            toggleBtn.style.display = 'block';
            postForm.reset();
        });

        // Form Submission Logic
        postForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = postForm.querySelector('button[type="submit"]');
            const originalText = submitBtn.textContent;
            
            const formData = new FormData(postForm);

            // Pre-submit validation
            const fileField = formData.get('bolDocument');
            if (fileField && fileField.size > 0) {
                if (fileField.size > 10 * 1024 * 1024) {
                    return showNotification('BOL file is too large. Maximum size is 10MB.', 'warning');
                }
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Posting...';

            try {
                await apiFetch('/api/loads/post', {
                    method: 'POST',
                    body: formData
                });
                
                showNotification('Load posted successfully!', 'success');
                
                // Reset and close the form panel
                formContainer.style.display = 'none';
                toggleBtn.style.display = 'block';
                postForm.reset();
                
                // Re-render the loads list immediately
                loadPostedLoads(container); 
            } catch (error) {
                showNotification(`Failed to post load: ${error.message}`, 'error');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }

    // Load the items immediately upon initialization
    await loadPostedLoads(container);
}

/**
 * Fetches and renders the loads posted by the user into the grid.
 */
async function loadPostedLoads(container) {
    container.innerHTML = '<p class="text-secondary">Loading your posted loads...</p>';

    try {
        const response = await apiFetch('/api/loads/posted');
        const loads = response.data;

        if (!loads || loads.length === 0) {
            container.innerHTML = '<p style="color: #666; font-style: italic;">You have not posted any loads yet.</p>';
            return;
        }

        container.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'loads-grid';
        grid.style.display = 'grid';
        grid.style.gap = '20px';
        grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(300px, 1fr))';

        loads.forEach(load => {
            const card = document.createElement('div');
            card.className = 'load-card';
            card.style.border = '1px solid #e0e0e0';
            card.style.padding = '15px';
            card.style.borderRadius = '8px';
            card.style.backgroundColor = '#fff';
            card.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)';

            let actionButtons = '';
            if (!load.status || load.status === 'available') {
                actionButtons = `
                    <div style="display: flex; gap: 10px;">
                        <button class="btn edit-load-btn" data-id="${load.id}" style="flex: 1; padding: 8px; border: 1px solid #007bff; background: transparent; color: #007bff; border-radius: 4px; cursor: pointer;">Edit</button>
                        <button class="btn cancel-load-btn" data-id="${load.id}" style="flex: 1; padding: 8px; border: 1px solid #dc3545; background: transparent; color: #dc3545; border-radius: 4px; cursor: pointer;">Cancel Load</button>
                    </div>
                `;
            } else {
                actionButtons = `<a href="/loads/${load.id}/status" style="display: block; text-align: center; width: 100%; padding: 8px; box-sizing: border-box; background: #f1f1f1; color: #333; border-radius: 4px; text-decoration: none;">Track Status</a>`;
            }

            // Note: Add rendering of the load's details inside the card here (matching your UI preferences)
            card.innerHTML = `
                <h4 style="margin: 0 0 10px 0; color: #333;">${load.title}</h4>
                <div style="font-size: 0.9em; color: #555; margin-bottom: 10px;">
                    <p style="margin: 5px 0;"><strong>Pickup:</strong> ${load.pickup_address}</p>
                    <p style="margin: 5px 0;"><strong>Delivery:</strong> ${load.delivery_address}</p>
                    <p style="margin: 5px 0;"><strong>Status:</strong> <span style="text-transform: capitalize; color: #007bff; font-weight: bold;">${(load.status || 'Available').replace('_', ' ')}</span></p>
                </div>
                ${actionButtons}
            `;
            grid.appendChild(card);
        });

        container.appendChild(grid);

        // Setup edit button click handler
        container.querySelectorAll('.edit-load-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const loadId = e.target.dataset.id;
                const load = loads.find(l => l.id == loadId);
                const card = e.target.closest('.load-card');
                
                renderEditLoadForm(card, load, container);
            });
        });

        // Setup the cancel button click handler
        container.querySelectorAll('.cancel-load-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const reason = prompt('Please provide a reason for cancelling this load:');
                if (reason === null) return;

                try {
                    await apiFetch(`/api/loads/${e.target.dataset.id}?reason=${encodeURIComponent(reason)}`, { method: 'DELETE' });
                    showNotification('Load cancelled successfully.', 'success');
                    await loadPostedLoads(container); // Refresh the list
                } catch (error) {
                    showNotification(`Failed to cancel load: ${error.message}`, 'error');
                }
            });
        });

    } catch (error) {
        container.innerHTML = `<p style="color: #dc3545;">Failed to load your posted loads: ${error.message}</p>`;
    }
}

/**
 * Replaces the load card with an inline form to edit the load details.
 */
function renderEditLoadForm(card, load, container) {
    const pickupDate = load.pickup_date ? new Date(load.pickup_date).toISOString().split('T')[0] : '';
    const deliveryDate = load.delivery_date ? new Date(load.delivery_date).toISOString().split('T')[0] : '';

    card.innerHTML = `
        <form class="edit-load-form" data-id="${load.id}">
            <div style="margin-bottom: 10px;">
                <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Title *</label>
                <input type="text" name="title" value="${load.title || ''}" required style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
            </div>
            <div style="margin-bottom: 10px;">
                <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Description</label>
                <textarea name="description" rows="2" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">${load.description || ''}</textarea>
            </div>
            <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                <div style="flex: 1;">
                    <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Pickup Address *</label>
                    <input type="text" name="pickupAddress" value="${load.pickup_address || ''}" required style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                </div>
                <div style="flex: 1;">
                    <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Delivery Address *</label>
                    <input type="text" name="deliveryAddress" value="${load.delivery_address || ''}" required style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                </div>
            </div>
            <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                <div style="flex: 1;">
                    <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Pickup Date</label>
                    <input type="date" name="pickupDate" value="${pickupDate}" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                </div>
                <div style="flex: 1;">
                    <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Delivery Date</label>
                    <input type="date" name="deliveryDate" value="${deliveryDate}" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                </div>
            </div>
            <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                <div style="flex: 1;">
                    <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Required Vehicle</label>
                    <select name="requiredVehicleClass" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                        <option value="" ${!load.required_vehicle_class ? 'selected' : ''}>Any</option>
                        <option value="flatbed" ${load.required_vehicle_class === 'flatbed' ? 'selected' : ''}>Flatbed</option>
                        <option value="dry_van" ${load.required_vehicle_class === 'dry_van' ? 'selected' : ''}>Dry van</option>
                        <option value="reefer" ${load.required_vehicle_class === 'reefer' ? 'selected' : ''}>Reefer</option>
                        <option value="other" ${load.required_vehicle_class === 'other' ? 'selected' : ''}>Other</option>
                    </select>
                </div>
                <div style="flex: 1;">
                    <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Weight (lbs)</label>
                    <input type="number" name="weight" value="${load.weight || ''}" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" min="1">
                </div>
                <div style="flex: 1;">
                    <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Rate ($)</label>
                    <input type="number" name="rate" value="${load.rate || ''}" style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" min="1" step="0.01">
                </div>
            </div>
            <div style="display: flex; gap: 10px;">
                <button type="submit" class="btn btn-primary" style="flex: 1; padding: 8px; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">Save</button>
                <button type="button" class="btn btn-secondary cancel-edit-btn" style="flex: 1; padding: 8px; background-color: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
            </div>
        </form>
    `;

    const form = card.querySelector('.edit-load-form');
    const pickupDateInput = form.querySelector('input[name="pickupDate"]');
    const deliveryDateInput = form.querySelector('input[name="deliveryDate"]');

    if (pickupDateInput && deliveryDateInput) {
        pickupDateInput.addEventListener('change', () => {
            if (pickupDateInput.value) {
                deliveryDateInput.min = pickupDateInput.value;
                if (deliveryDateInput.value && deliveryDateInput.value < pickupDateInput.value) {
                    deliveryDateInput.value = ''; // Reset invalid end date
                }
            } else {
                deliveryDateInput.min = '';
            }
        });
    }

    card.querySelector('.cancel-edit-btn').addEventListener('click', () => {
        loadPostedLoads(container); // Re-renders the list to return to view mode
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';

        const formData = new FormData(form);
        
        // Safely handle optional number fields
        if (!formData.get('weight')) formData.delete('weight');
        if (!formData.get('rate')) formData.delete('rate');

        try {
            await apiFetch(`/api/loads/${load.id}`, {
                method: 'PUT',
                body: formData
            });
            showNotification('Load updated successfully.', 'success');
            loadPostedLoads(container); // Refresh to display the new info
        } catch (error) {
            showNotification(`Failed to update load: ${error.message}`, 'error');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save';
        }
    });
}