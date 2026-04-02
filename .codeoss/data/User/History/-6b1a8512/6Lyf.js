/*
    Reusable Mapbox map generation script.
    - It geocodes start and end locations.
    - It fetches and displays a driving route.
    - It adds markers for the start and end points.
    - It handles errors gracefully.

    Usage:
    1. Include Mapbox GL JS and this script in your HTML.
    2. Set `mapboxgl.accessToken` in a <script> tag before including this file.
    3. On DOMContentLoaded, call `initializeMaps(options)` with the correct parameters for your page.
*/

async function geocode(place) {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(place)}.json?access_token=${mapboxgl.accessToken}&limit=1`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.features && data.features.length > 0) {
        return data.features[0].center; // [longitude, latitude]
    }
    return null;
}

async function getRoute(start, end) {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${start[0]},${start[1]};${end[0]},${end[1]}?geometries=geojson&access_token=${mapboxgl.accessToken}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.routes && data.routes.length > 0) {
        return data.routes[0].geometry;
    }
    return null;
}

async function initializeMaps(options) {
    const { cardSelector, startLocationAttr, endLocationAttr, idAttr, idPrefix } = options;

    const cards = document.querySelectorAll(cardSelector);

    cards.forEach(async (card) => {
        const startLocation = card.dataset[startLocationAttr];
        const endLocation = card.dataset[endLocationAttr];
        const itemId = card.dataset[idAttr];
        const mapContainerId = `${idPrefix}-${itemId}`;

        if (!startLocation || !endLocation) return;

        try {
            const [startCoords, endCoords] = await Promise.all([
                geocode(startLocation),
                geocode(endLocation)
            ]);

            if (!startCoords || !endCoords) {
                console.error(`Could not geocode one or both locations for item ${itemId}: ${startLocation}, ${endLocation}`);
                document.getElementById(mapContainerId).innerHTML = '<p style="text-align:center; padding-top: 80px; color: #888;">Could not display map.</p>';
                return;
            }

            const routeGeoJSON = await getRoute(startCoords, endCoords);

            const map = new mapboxgl.Map({
                container: mapContainerId,
                style: 'mapbox://styles/mapbox/streets-v11',
                center: startCoords,
                zoom: 4,
                interactive: false // Make map non-interactive for a cleaner list view
            });

            map.on('load', () => {
                new mapboxgl.Marker({ color: '#32CD32' }).setLngLat(startCoords).addTo(map);
                new mapboxgl.Marker({ color: '#FF4500' }).setLngLat(endCoords).addTo(map);

                if (routeGeoJSON) {
                    const routeId = `route-${itemId}`;
                    map.addSource(routeId, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: routeGeoJSON } });
                    map.addLayer({ id: routeId, type: 'line', source: routeId, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3887be', 'line-width': 5, 'line-opacity': 0.75 } });
                    const bounds = new mapboxgl.LngLatBounds(startCoords, endCoords);
                    map.fitBounds(bounds, { padding: 50 });
                }
            });
        } catch (error) {
            console.error(`Error creating map for item ${itemId}:`, error);
            document.getElementById(mapContainerId).innerHTML = '<p style="text-align:center; padding-top: 80px; color: #888;">Error loading map.</p>';
        }
    });
}

// --- Autocomplete functionality ---
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

async function fetchCitySuggestions(query, listId, spinnerId) {
    const spinner = document.getElementById(spinnerId);
    const dataList = document.getElementById(listId);
    if (!dataList) return;
    
    dataList.innerHTML = ''; // Clear previous suggestions on new input

    if (!query || query.length < 3) {
        if (spinner) spinner.style.display = 'none';
        return; // Wait for 3 characters to save API calls
    }
    
    if (spinner) spinner.style.display = 'block';

    // types=place restricts results to cities and towns, country restricts to US and Canada
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?types=place&country=us,ca&access_token=${mapboxgl.accessToken}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        data.features.forEach(feature => {
            const option = document.createElement('option');
            option.value = feature.place_name; // e.g., "Seattle, Washington, United States"
            dataList.appendChild(option);
        });
    } catch (error) {
        console.error('Error fetching suggestions:', error);
    } finally {
        if (spinner) spinner.style.display = 'none';
    }
}

function setupAutocomplete(inputId, listId, spinnerId) {
    const input = document.getElementById(inputId);
    if (input) {
        input.addEventListener('input', debounce((e) => fetchCitySuggestions(e.target.value, listId, spinnerId), 300));
    }
}

// --- Form Submission Handling ---
async function setupFormSubmit(formId, endpoint, resultId, customHandler = null) {
    const form = document.getElementById(formId);
    const resultContainer = document.getElementById(resultId);

    if (!form || !resultContainer) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(form);
        resultContainer.innerHTML = '<p>Please wait...</p>'; // Provide user feedback
        resultContainer.style.display = 'block'; // Make sure the container is visible

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                body: formData
            });
            const result = await response.json();

            if (customHandler) {
                customHandler(result, resultContainer);
            } else {
                // Show user-friendly success or error messages
                if (response.ok) {
                    resultContainer.innerHTML = `<p class="success-message">${result.message || 'Successfully submitted!'}</p>`;
                    form.reset(); // Clear the form on success
                } else {
                    resultContainer.innerHTML = `<p class="error-message">${result.error || result.message || 'An error occurred. Please try again.'}</p>`;
                }
            }
        } catch (error) {
            resultContainer.innerText = "An error occurred.";
            console.error(error);
        }
    });
}

function displayMatches(trucks, resultContainer) {
    resultContainer.innerHTML = ''; // Clear previous results

    if (trucks.message) { // Handle "No matches found" message from the server
        resultContainer.innerHTML = `<p class="no-results">${trucks.message}</p>`;
        return;
    }

    if (!Array.isArray(trucks) || trucks.length === 0) {
        resultContainer.innerHTML = '<p class="no-results">No matching trucks found.</p>';
        return;
    }

    trucks.forEach(truck => {
        const card = document.createElement('div');
        card.className = 'card'; // Reuse the card style

        const rating = truck.rating_count > 0 ? `★ ${truck.avg_rating.toFixed(2)} (${truck.rating_count} reviews)` : '(No reviews yet)';
        const verifiedBadge = truck.id_verified ? '<span class="badge" style="background-color: #28a745; color: white; font-size: 0.7em; vertical-align: middle; padding: 3px 6px; border-radius: 10px; margin-left: 5px;">✓ ID Verified</span>' : '';

        card.innerHTML = `
            <h3>${truck.vehicle_type} (ID: ${truck.vehicle_id})</h3>
            <p><strong>Transporter:</strong> <a href="/profile/${truck.driver_id}">${truck.username}</a> ${verifiedBadge} <span class="rating">${rating}</span></p>
            <p><strong>Route:</strong> ${truck.departure_city} &rarr; ${truck.destination_city}</p>
            <p><strong>Available:</strong> ${truck.start_date} to ${truck.end_date}</p>
            ${truck.max_weight ? `<p><strong>Max Capacity:</strong> ${truck.max_weight} lbs</p>` : ''}
            ${truck.max_dimensions ? `<p><strong>Max Dimensions:</strong> ${truck.max_dimensions}</p>` : ''}
            <p><strong>Equipment:</strong> ${truck.has_loading_equipment ? 'Has own loading equipment' : 'No loading equipment provided'}</p>
            <div class="card-actions" style="margin-top: 15px; display: flex; gap: 10px;">
                <a href="/chat/${truck.driver_id}" class="btn btn-success">Message Transporter</a>
                <a href="/?vehicle_id=${truck.vehicle_id}#matchSection" class="btn">Request This Truck</a>
            </div>
        `;
        resultContainer.appendChild(card);
    });
}

// --- Bidding Modal Logic ---
function setupBiddingModal() {
    const modal = document.getElementById('bidModal');
    const closeModal = document.querySelector('.modal .close');
    const bidForm = document.getElementById('bidForm');
    const bidResult = document.getElementById('bidResult');

    if (!modal) return;

    // Use event delegation to handle clicks on "Make an Offer" buttons.
    // This ensures that buttons on loads added via pagination or in hidden tabs will work.
    document.body.addEventListener('click', function(event) {
        if (event.target.classList.contains('make-offer-btn')) {
            const button = event.target;
            const loadId = button.dataset.loadId;
            const loadDescription = button.dataset.loadDescription;

            // Populate the modal
            const modalLoadId = document.getElementById('modalLoadId');
            const modalLoadDesc = document.getElementById('modalLoadDescription');
            if (modalLoadId) modalLoadId.value = loadId;
            if (modalLoadDesc) modalLoadDesc.textContent = loadDescription;
            
            // Clear previous results and show modal
            if (bidResult) bidResult.innerHTML = '';
            if (bidForm) {
                bidForm.reset();
                bidForm.style.display = 'block';
            }
            modal.style.display = 'block';
        }
    });

    // Close modal when 'x' is clicked
    if (closeModal) {
        closeModal.onclick = function() {
            modal.style.display = 'none';
        }
    }

    // Close modal when user clicks outside of it
    window.onclick = function(event) {
        if (event.target == modal) {
            modal.style.display = 'none';
        }
    }

    // Handle bid form submission
    if (bidForm) {
        bidForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(bidForm);
            const loadId = formData.get('load_id');
            
            if (bidResult) bidResult.innerHTML = '<p>Submitting offer...</p>';

            try {
                const response = await fetch(`/load/${loadId}/bid`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.fromEntries(formData))
                });
                const result = await response.json();

                if (response.ok) {
                    bidResult.innerHTML = `<p class="success-message">${result.message}</p>`;
                    bidForm.style.display = 'none'; // Hide form on success
                } else {
                    bidResult.innerHTML = `<p class="error-message">${result.error || 'An unknown error occurred.'}</p>`;
                }
            } catch (error) {
                if (bidResult) bidResult.innerHTML = `<p class="error-message">An error occurred while submitting your offer.</p>`;
            }
        });
    }
}