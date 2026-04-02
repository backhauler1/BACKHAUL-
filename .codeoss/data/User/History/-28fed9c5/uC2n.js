import { showNotification } from './notifications.js';
import { apiFetch } from './apiUtil.js';
import { updateMapMarkers, drawRoute, clearRoute } from './mapbox_maps.js';
import { renderResultsList } from './results_view.js';

/**
 * Initializes all relevant forms on the page.
 * This acts as a dispatcher for form-specific setup functions.
 */
export function setupAllForms() {
    const findTruckForm = document.getElementById('find-truck-form');
    if (findTruckForm) {
        setupFindTruckForm(findTruckForm);
    }

    const findLoadForm = document.getElementById('find-load-form');
    if (findLoadForm) {
        setupFindLoadForm(findLoadForm);
    }

    const findCompanyForm = document.getElementById('find-company-form');
    if (findCompanyForm) {
        setupFindCompanyForm(findCompanyForm);
    }

    const registerCompanyForm = document.getElementById('register-company-form');
    if (registerCompanyForm) {
        setupCompanyRegistrationForm(registerCompanyForm);
    }

    const checkoutForm = document.getElementById('checkout-form');
    if (checkoutForm) {
        setupCheckoutForm(checkoutForm);
    }

    const postLoadForm = document.getElementById('post-load-form');
    if (postLoadForm) {
        setupPostLoadForm(postLoadForm);
    }

    const updateEtaForm = document.getElementById('update-eta-form');
    if (updateEtaForm) {
        setupUpdateEtaForm(updateEtaForm);
    }

    const ratingForm = document.getElementById('rating-form');
    if (ratingForm) {
        setupRatingForm(ratingForm);
    }
}

/**
 * Helper function to enforce date constraints between a start and end date input.
 * Prevents selecting past dates and ensures the end date is not before the start date.
 * @param {HTMLInputElement} startDateInput - The input element for the start date.
 * @param {HTMLInputElement} endDateInput - The input element for the end date.
 */
function setupDateConstraints(startDateInput, endDateInput) {
    if (!startDateInput && !endDateInput) return;

    const today = new Date();
    const localDateString = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    
    if (startDateInput) startDateInput.min = localDateString;
    if (endDateInput) endDateInput.min = localDateString;

    if (startDateInput && endDateInput) {
        startDateInput.addEventListener('change', () => {
            if (startDateInput.value) {
                endDateInput.min = startDateInput.value;
                if (endDateInput.value && endDateInput.value < startDateInput.value) {
                    endDateInput.value = ''; // Clear invalid end date
                }
            } else {
                endDateInput.min = localDateString; // Reset to today if cleared
            }
        });
    }
}

/**
 * Sets up the interactive 5-star rating form.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupRatingForm(formElement) {
    const stars = formElement.querySelectorAll('.star-btn');
    const ratingInput = formElement.querySelector('input[name="rating"]');

    // Handle visual star selection
    stars.forEach(star => {
        star.addEventListener('click', (e) => {
            e.preventDefault();
            const value = parseInt(star.dataset.value, 10);
            ratingInput.value = value;
            
            // Fill in the stars up to the selected value
            stars.forEach(s => {
                if (parseInt(s.dataset.value, 10) <= value) {
                    s.classList.add('selected');
                    s.textContent = '★'; // Filled star
                } else {
                    s.classList.remove('selected');
                    s.textContent = '☆'; // Empty star
                }
            });
        });
    });

    // Handle submission
    formElement.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const loadId = formElement.querySelector('input[name="loadId"]').value;
        const targetUserId = formElement.querySelector('input[name="targetUserId"]').value;
        const reviewInput = formElement.querySelector('textarea[name="review"]');
        const rating = ratingInput.value;
        const review = reviewInput ? reviewInput.value.trim() : undefined;

        if (!rating) return showNotification('Please select a star rating first.', 'warning');

        try {
            const response = await apiFetch(`/api/loads/${loadId}/rate`, {
                method: 'POST',
                body: { rating, targetUserId }
                body: { rating, targetUserId, review }
            });
            showNotification(response.message, 'success');
            formElement.innerHTML = '<p style="color: green; font-weight: bold;">Thank you for your feedback!</p>';
        } catch (error) {
            showNotification(`Failed to submit rating: ${error.message}`, 'error');
        }
    });
}

/**
 * Sets up the "Post Load" form with date restrictions.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupPostLoadForm(formElement) {
    // Based on your loads.js schema, the inputs would be named pickupDate and deliveryDate
    const pickupDateInput = formElement.querySelector('input[name="pickupDate"]');
    const deliveryDateInput = formElement.querySelector('input[name="deliveryDate"]');
    
    // Apply the reusable date constraints
    setupDateConstraints(pickupDateInput, deliveryDateInput);

    formElement.addEventListener('submit', async (e) => {
        e.preventDefault();

        const pickupDate = pickupDateInput ? pickupDateInput.value : null;
        const deliveryDate = deliveryDateInput ? deliveryDateInput.value : null;

        if (pickupDate && deliveryDate && new Date(pickupDate) > new Date(deliveryDate)) {
            showNotification('Delivery date cannot be before pickup date.', 'warning');
            return;
        }

        const submitButton = formElement.querySelector('button[type="submit"]');
        const originalButtonText = submitButton ? submitButton.textContent : 'Post Load';
        
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = 'Posting...';
        }

        try {
            const formData = new FormData(formElement);
            const payload = Object.fromEntries(formData.entries());

            const responseData = await apiFetch('/api/loads/post', {
                method: 'POST',
                body: payload,
            });

            showNotification(responseData.message || 'Load posted successfully!', 'success');
            formElement.reset(); // Clear the form on success
        } catch (error) {
            showNotification(`Failed to post load: ${error.message}`, 'error');
        } finally {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = originalButtonText;
            }
        }
    });
}

/**
 * Sets up the "Update ETA" form for drivers.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupUpdateEtaForm(formElement) {
    formElement.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Expecting inputs like <input type="hidden" name="loadId" value="123">
        // and <input type="datetime-local" name="eta">
        const loadIdInput = formElement.querySelector('input[name="loadId"]');
        const etaInput = formElement.querySelector('input[name="eta"]');
        
        const loadId = loadIdInput ? loadIdInput.value : null;
        const eta = etaInput ? etaInput.value : null;

        if (!loadId || !eta) {
            showNotification('Please select a valid date and time.', 'warning');
            return;
        }

        const submitButton = formElement.querySelector('button[type="submit"]');
        const originalButtonText = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = 'Updating...';

        try {
            const responseData = await apiFetch(`/api/loads/${loadId}/eta`, {
                method: 'PATCH',
                body: { eta },
            });

            showNotification(responseData.message || 'ETA updated successfully!', 'success');
            
            // If the form is inside a modal, close it and reset
            const modal = document.getElementById('eta-modal');
            if (modal) {
                modal.style.display = 'none';
                formElement.reset();
            }

            // If an ETA display element exists for this load on the screen, update it instantly
            const etaDisplayElement = document.getElementById(`eta-display-${loadId}`);
            if (etaDisplayElement) {
                const formattedEta = new Date(eta).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
                etaDisplayElement.innerHTML = `<span class="label">Current ETA:</span> <strong>${formattedEta}</strong>`;
            }
        } catch (error) {
            showNotification(`Failed to update ETA: ${error.message}`, 'error');
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = originalButtonText;
        }
    });
}

/**
 * Sets up the "Find Truck" form with async submission and validation.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupFindTruckForm(formElement) {
    let currentPage = 1;
    let currentFormData = null;
    let allResults = [];
    let isLastPage = true;

    // --- UI Element References ---
    const loadMoreBtn = document.getElementById('load-more-btn');
    const sortControls = document.getElementById('sort-controls');
    const sortSelect = document.getElementById('sort-options');

    /**
     * Sorts the `allResults` array based on the current dropdown selection
     * and re-renders the entire results list.
     */
    function sortAndRenderResults() {
        if (!sortSelect) return;

        const sortBy = sortSelect.value;

        allResults.sort((a, b) => {
            // Primary sort: always put unavailable trucks at the bottom.
            // Assumes `isAvailable: false` means unavailable. `undefined` or `true` means available.
            const aAvailable = a.isAvailable !== false;
            const bAvailable = b.isAvailable !== false;
            if (aAvailable !== bAvailable) {
                return bAvailable - aAvailable; // This will sort `true` values (available) before `false` (unavailable).
            }

            if (sortBy === 'name') {
                // localeCompare is ideal for sorting strings alphabetically, handling different languages.
                return (a.name || '').localeCompare(b.name || '');
            }
            if (sortBy === 'distance') {
                // Assumes your API provides a 'distance' property.
                // Trucks without a distance are pushed to the end.
                return (a.distance ?? Infinity) - (b.distance ?? Infinity);
            }
            return 0;
        });

        // Re-render the entire list with the newly sorted data.
        renderResultsList(allResults, { clear: true });
    }

    formElement.addEventListener('submit', async (e) => {
        e.preventDefault(); // Prevent traditional form submission

        // Reset state for a new search
        currentPage = 1;
        allResults = [];
        currentFormData = new FormData(formElement);

        // Hide controls until we have results
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
        if (sortControls) sortControls.style.display = 'none';

        const submitButton = formElement.querySelector('button[type="submit"]');
        const originalButtonText = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = 'Searching...';

        try {
            // Your backend API now needs to support pagination, e.g., via a query parameter.
            const url = new URL(window.location.origin + '/api/trucks/find');
            url.searchParams.set('page', currentPage);

            // apiFetch automatically handles error checking and JSON parsing
            const responseData = await apiFetch(url, {
                method: 'POST',
                body: currentFormData,
            });
            allResults = responseData.data || [];
            const pagination = responseData.pagination;

            if (Array.isArray(allResults)) {
                if (allResults.length === 0) {
                    showNotification('No trucks found matching your criteria.', 'info');
                } else {
                    showNotification(`Found ${allResults.length} trucks near you!`, 'success');
                    if (sortControls) sortControls.style.display = 'block'; // Show sort controls
                }

                // Sort the initial results and render the list
                sortAndRenderResults();

                // Update the map with the new markers
                updateMapMarkers(allResults, { clear: true });

                // Check if there are more pages to load.
                isLastPage = !pagination || pagination.currentPage >= pagination.totalPages;
                if (loadMoreBtn && !isLastPage && allResults.length > 0) {
                    loadMoreBtn.style.display = 'block'; // Show the "Load More" button
                }
            } else {
                showNotification('Search completed, but received an unexpected data format.', 'warning');
            }

            console.log('Search Results:', results);
        } catch (error) {
            showNotification(`Search failed: ${error.message}`, 'error');
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = originalButtonText;
        }
    });

    // --- Event Listener for "Load More" ---
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', async () => {
            if (isLastPage || !currentFormData) return;

            currentPage++;

            loadMoreBtn.disabled = true;
            const originalButtonText = loadMoreBtn.textContent;
            loadMoreBtn.textContent = 'Loading...';

            try {
                const url = new URL(window.location.origin + '/api/trucks/find');
                url.searchParams.set('page', currentPage);

                const responseData = await apiFetch(url, {
                    method: 'POST',
                    body: currentFormData, // Use the stored form data from the initial search
                });
                const newResults = responseData.data;
                const pagination = responseData.pagination;

                if (Array.isArray(newResults) && newResults.length > 0) {
                    allResults = allResults.concat(newResults);
                    showNotification(`Loaded ${newResults.length} more trucks.`, 'success');
                    // Sort and re-render the combined list
                    sortAndRenderResults();
                    // Add the new markers to the map without clearing old ones
                    updateMapMarkers(newResults, { clear: false });
                }

                isLastPage = !pagination || pagination.currentPage >= pagination.totalPages;
                if (isLastPage) {
                    loadMoreBtn.style.display = 'none';
                }
            } catch (error) {
                showNotification(`Failed to load more: ${error.message}`, 'error');
            } finally {
                loadMoreBtn.disabled = false;
                loadMoreBtn.textContent = originalButtonText;
            }
        });
    }

    // --- Event Listener for Sort Dropdown ---
    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            if (allResults.length > 0) {
                sortAndRenderResults();
            }
        });
    }
}

/**
 * Sets up the checkout form to create a Stripe Payment Intent.
 * This form would typically be used for purchasing services like load posting fees,
 * or other premium features.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupCheckoutForm(formElement) {
    let stripe = null;
    let elements = null;
    let isPaymentMounted = false;

    // Check if this is a retry for a failed order and pre-fill/update UI before submission
    const urlParams = new URLSearchParams(window.location.search);
    const retryOrderId = urlParams.get('retryOrder');
    
    if (retryOrderId) {
        apiFetch(`/api/orders/${retryOrderId}`)
            .then(responseData => {
                if (responseData && responseData.data) {
                    const order = responseData.data;
                    const amountInDollars = (order.amount / 100).toFixed(2);
                    
                    // Display a banner indicating they are retrying
                    const infoBanner = document.createElement('div');
                    infoBanner.style.padding = '10px';
                    infoBanner.style.marginBottom = '15px';
                    infoBanner.style.backgroundColor = '#f8d7da';
                    infoBanner.style.color = '#721c24';
                    infoBanner.style.borderRadius = '5px';
                    infoBanner.innerHTML = `<strong>Retrying Order #${order.id}:</strong> $${amountInDollars} ${order.currency.toUpperCase()}`;
                    
                    formElement.insertBefore(infoBanner, formElement.firstChild);
                    
                    // Example: Lock form fields that shouldn't change for a retried order
                    const expressCheckbox = formElement.querySelector('#express-shipping-checkbox');
                    if (expressCheckbox) expressCheckbox.disabled = true;
                }
            })
            .catch(err => console.error('Failed to fetch order details:', err));
    }

    formElement.addEventListener('submit', async (e) => {
        e.preventDefault();

        const submitButton = formElement.querySelector('button[type="submit"]');
        const originalButtonText = submitButton.textContent;
        submitButton.disabled = true;

        if (!isPaymentMounted) {
            // --- Step 1: Initialize Payment Element ---
            submitButton.textContent = 'Preparing Secure Payment...';
            
            // Inject a loading spinner into the payment element container
            const paymentElementContainer = document.getElementById('payment-element');
            if (paymentElementContainer) {
                paymentElementContainer.innerHTML = `
                    <div style="text-align: center; padding: 30px;">
                        <svg width="40" height="40" viewBox="0 0 50 50" style="animation: spin 1s linear infinite;">
                            <circle cx="25" cy="25" r="20" fill="none" stroke="#e0e0e0" stroke-width="4"></circle>
                            <circle cx="25" cy="25" r="20" fill="none" stroke="#007bff" stroke-width="4" stroke-dasharray="30 100" stroke-linecap="round"></circle>
                        </svg>
                        <p style="margin-top: 15px; color: #666; font-size: 0.9em;">Loading secure payment...</p>
                        <style>@keyframes spin { 100% { transform: rotate(360deg); } }</style>
                    </div>`;
            }

            try {
                const items = [{ id: 'load-posting-fee', quantity: 1 }];
                const expressCheckbox = formElement.querySelector('#express-shipping-checkbox');
                const isExpress = expressCheckbox ? expressCheckbox.checked : false;

                // Check if this is a retry for a failed order
                const urlParams = new URLSearchParams(window.location.search);
                const retryOrderId = urlParams.get('retryOrder');

                // Fetch Stripe config and create Payment Intent simultaneously
                const [configResponse, piResponse] = await Promise.all([
                    fetch('/api/stripe/config'),
                    fetch('/api/stripe/create-payment-intent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ items, isExpress, retryOrderId }),
                    })
                ]);

                const configData = await configResponse.json();
                const piData = await piResponse.json();

                if (!piResponse.ok) throw new Error(piData.message || 'Failed to initialize payment.');
                if (typeof Stripe === 'undefined') throw new Error('Stripe.js is missing. Please reload the page.');

                stripe = Stripe(configData.publishableKey);
                elements = stripe.elements({ clientSecret: piData.clientSecret });
                
                // Clear the loading spinner right before mounting the element
                if (paymentElementContainer) paymentElementContainer.innerHTML = '';

                const paymentElement = elements.create('payment');
                paymentElement.mount('#payment-element');
                isPaymentMounted = true;

                // Lock the checkbox so they can't change the price after the Intent is generated
                if (expressCheckbox) expressCheckbox.disabled = true;

                submitButton.textContent = 'Confirm Payment';
                submitButton.disabled = false;
            } catch (error) {
                showNotification(`Payment prep failed: ${error.message}`, 'error');
                submitButton.disabled = false;
                submitButton.textContent = originalButtonText;
            }
        } else {
            // --- Step 2: Confirm Payment ---
            submitButton.textContent = 'Processing Payment...';
            try {
                const { error } = await stripe.confirmPayment({
                    elements,
                    confirmParams: {
                        // Redirect to the invoices page after a successful transaction
                        return_url: window.location.origin + '/invoices',
                    },
                });

                // If `error` exists, the payment failed (e.g. invalid card). 
                // If successful, Stripe automatically redirects before reaching this point.
                if (error) showNotification(error.message, 'warning');
            } catch (error) {
                showNotification('An unexpected error occurred processing your payment.', 'error');
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = 'Confirm Payment';
            }
        }
    });
}

/**
 * Sets up the "Find a Company" form for users looking for transport services.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupFindCompanyForm(formElement) {
    // This function handles form submission, calls a new API endpoint for companies,
    // and uses the existing render functions to display results.
    formElement.addEventListener('submit', async (e) => {
        e.preventDefault();

        const formData = new FormData(formElement);
        const submitButton = formElement.querySelector('button[type="submit"]');
        const originalButtonText = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = 'Searching...';

        // Clear previous results from the list and map
        renderResultsList([], { clear: true });
        updateMapMarkers([], { clear: true });

        try {
            // This assumes a new API endpoint for searching companies.
            const responseData = await apiFetch('/api/companies/find', {
                method: 'POST',
                body: formData,
            });
            // The backend should return a list of company profiles.
            // We add a 'type' property so our renderers know how to handle them.
            let results = responseData.data || [];
            results = results.map(company => ({ ...company, type: 'company' }));

            if (results.length === 0) {
                showNotification('No transport companies found for your search.', 'info');
            } else {
                showNotification(`Found ${results.length} companies.`, 'success');
            }

            renderResultsList(results, { clear: true });
            updateMapMarkers(results, { clear: true });
        } catch (error) {
            showNotification(`Search failed: ${error.message}`, 'error');
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = originalButtonText;
        }
    });
}

/**
 * Sets up the "Register Company" form.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupCompanyRegistrationForm(formElement) {
    formElement.addEventListener('submit', async (e) => {
        e.preventDefault();

        const formData = new FormData(formElement);
        
        // Validate the uploaded image format before sending to the server
        const thumbnailFile = formData.get('thumbnail');
        if (thumbnailFile && thumbnailFile.size > 0) {
            const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
            if (!validImageTypes.includes(thumbnailFile.type)) {
                showNotification('Please upload a valid image file (JPEG, PNG, GIF, or WebP).', 'warning');
                return; // Stop the submission
            }
        }

        const submitButton = formElement.querySelector('button[type="submit"]');
        const originalButtonText = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = 'Registering...';

        try {
            await apiFetch('/api/companies/register', {
                method: 'POST',
                body: formData, // FormData automatically handles the correct Content-Type, including file uploads
            });

            showNotification('Company registered successfully!', 'success');
            formElement.reset(); // Clear the form on success
            // Optional: window.location.href = '/dashboard'; // Redirect the user
        } catch (error) {
            showNotification(`Registration failed: ${error.message}`, 'error');
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = originalButtonText;
        }
    });
}

/**
 * Sets up the "Find Load" form for drivers to search for available loads.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupFindLoadForm(formElement) {
    let currentPage = 1;
    let currentFormData = null;
    let allResults = [];
    let isLastPage = true;

    const loadMoreBtn = document.getElementById('load-more-btn');
    const sortControls = document.getElementById('sort-controls');
    const sortSelect = document.getElementById('sort-options');

    // Set minimum date for date inputs to today to prevent selecting past dates
    const startDateInput = formElement.querySelector('input[name="startDate"]');
    const endDateInput = formElement.querySelector('input[name="endDate"]');
    
    // Apply the reusable date constraints
    setupDateConstraints(startDateInput, endDateInput);

    function sortAndRenderResults() {
        if (!sortSelect) return;
        const sortBy = sortSelect.value;
        allResults.sort((a, b) => {
            if (sortBy === 'date') {
                return new Date(b.pickupDate || 0) - new Date(a.pickupDate || 0);
            }
            if (sortBy === 'distance') {
                return (a.distance ?? Infinity) - (b.distance ?? Infinity);
            }
            return 0;
        });
        renderResultsList(allResults, { clear: true });
    }

    formElement.addEventListener('submit', async (e) => {
        e.preventDefault();
        currentPage = 1;
        allResults = [];
        currentFormData = new FormData(formElement);
        
        clearRoute(); // Clear the old route from the map before a new search

        // Add validation for back-haul search fields.
        // Assumes your form has inputs with name="backhaul-origin" and name="backhaul-destination"
        const origin = currentFormData.get('backhaul-origin');
        const destination = currentFormData.get('backhaul-destination');

        if (!origin || !destination) {
            showNotification('Please provide both an origin and a destination for your back-haul route.', 'warning');
            return; // Stop the submission if fields are missing
        }

        const startDate = currentFormData.get('startDate');
        const endDate = currentFormData.get('endDate');

        if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
            showNotification('End date cannot be before start date.', 'warning');
            return;
        }

        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
        if (sortControls) sortControls.style.display = 'none';

        const submitButton = formElement.querySelector('button[type="submit"]');
        const originalButtonText = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = 'Searching Loads...';

        try {
            const url = new URL(window.location.origin + '/api/loads/find');
            url.searchParams.set('page', currentPage);

            const responseData = await apiFetch(url, {
                method: 'POST',
                body: currentFormData,
            });
            allResults = responseData.data || [];

            // If the backend returned the route geometry, draw it on the map!
            if (responseData.routeGeometry) {
                drawRoute(responseData.routeGeometry);
            }
            
            // Mark these results as 'load' type so the renderer knows how to display them
            allResults = allResults.map(load => ({ ...load, type: 'load' }));
            
            const pagination = responseData.pagination;

            if (allResults.length === 0) {
                showNotification('No loads found matching your criteria.', 'info');
            } else {
                showNotification(`Found ${allResults.length} available loads!`, 'success');
                if (sortControls) sortControls.style.display = 'block';
            }

            sortAndRenderResults();
            updateMapMarkers(allResults, { clear: true });

            isLastPage = !pagination || pagination.currentPage >= pagination.totalPages;
            if (loadMoreBtn && !isLastPage && allResults.length > 0) {
                loadMoreBtn.style.display = 'block';
            }
        } catch (error) {
            showNotification(`Search failed: ${error.message}`, 'error');
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = originalButtonText;
        }
    });

    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', async () => {
            if (isLastPage || !currentFormData) return;
            currentPage++;
            loadMoreBtn.disabled = true;
            loadMoreBtn.textContent = 'Loading...';

            try {
                const url = new URL(window.location.origin + '/api/loads/find');
                url.searchParams.set('page', currentPage);
                const responseData = await apiFetch(url, { method: 'POST', body: currentFormData });
                let newResults = responseData.data || [];
                newResults = newResults.map(load => ({ ...load, type: 'load' }));
                const pagination = responseData.pagination;

                if (newResults.length > 0) {
                    allResults = allResults.concat(newResults);
                    sortAndRenderResults();
                    updateMapMarkers(newResults, { clear: false });
                }

                isLastPage = !pagination || pagination.currentPage >= pagination.totalPages;
                if (isLastPage) loadMoreBtn.style.display = 'none';
            } catch (error) {
                showNotification(`Failed to load more: ${error.message}`, 'error');
            } finally {
                loadMoreBtn.disabled = false;
                loadMoreBtn.textContent = 'Load More';
            }
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            if (allResults.length > 0) sortAndRenderResults();
        });
    }
}