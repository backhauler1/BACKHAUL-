import { focusMapMarker } from './mapbox_maps.js';

/**
 * Manages the rendering of search results into a list view.
 */

// A reference to the container where results will be displayed.
// Assumes an element with this ID exists in the HTML, e.g., <div id="results-list-container"></div>
const resultsContainer = document.getElementById('results-list-container');

/**
 * Renders or appends a list of truck or load results to the DOM.
 * @param {Array<Object>} results - The array of truck or load data from the API.
 * @param {Object} [options] - Configuration options.
 * @param {boolean} [options.clear=true] - Whether to clear the existing list before rendering.
 */
export function renderResultsList(results, options = {}) {
    if (!resultsContainer) {
        // Don't show an error, just log a warning in case some pages don't have this element.
        console.warn('Results list container (#results-list-container) not found. Skipping list render.');
        return;
    }

    const { clear = true } = options;

    if (clear) {
        resultsContainer.innerHTML = ''; // Clear previous results
    }

    if (!results || results.length === 0) {
        // If this was a new search that returned nothing, we don't need to do anything else.
        return;
    }

    const fragment = document.createDocumentFragment();
    results.forEach(item => {
        const resultItem = _createResultItemElement(item);
        fragment.appendChild(resultItem);
    });

    resultsContainer.appendChild(fragment);
}

/**
 * Creates a single DOM element for a result item by dispatching to a type-specific function.
 * @param {Object} item - The result data object (truck, load, or company).
 * @returns {HTMLElement}
 * @private
 */
function _createResultItemElement(item) {
    // Dispatch to the correct renderer based on the item's type.
    // The 'type' property is added in the form submission logic.
    if (item.type === 'load') {
        return _createLoadResultItem(item);
    }
    if (item.type === 'company') {
        return _createCompanyResultItem(item);
    }
    
    // Default to creating a truck item if type is not specified
    return _createTruckResultItem(item);
}

/**
 * Creates a DOM element for a transport company result item.
 * @param {Object} company - The company data object.
 * @returns {HTMLElement}
 * @private
 */
function _createCompanyResultItem(company) {
    const item = document.createElement('div');
    item.className = 'result-item result-item--company'; // Add a specific class for styling

    // Assumes company object from API has: name, description, services (array), thumbnailUrl, lng, lat
    const placeholderImg = 'https://via.placeholder.com/80x80.png?text=Company';
    const servicesHTML = company.services && company.services.length
        ? `<p class="result-item-services" style="font-size: 0.85em; color: #666; margin: 2px 0;"><strong>Services:</strong> ${company.services.join(', ')}</p>`
        : '';

    item.innerHTML = `
        <img src="${company.thumbnailUrl || placeholderImg}" alt="${company.name || 'Company'}" class="result-item-thumbnail">
        <div class="result-item-details">
            <h5 class="result-item-name">${company.name || 'Unnamed Company'}</h5>
            <p class="result-item-description">${company.description || 'No description available.'}</p>
            ${servicesHTML}
        </div>
    `;

    // Add a click event to focus the map on the company's office/location
    if (company.lng !== undefined && company.lat !== undefined) {
        item.addEventListener('click', () => {
            const currentActive = resultsContainer.querySelector('.result-item.active');
            if (currentActive) {
                currentActive.classList.remove('active');
            }
            item.classList.add('active');
            focusMapMarker(company.lng, company.lat);
        });
    } else {
        item.style.cursor = 'default';
    }

    return item;
}

/**
 * Creates a DOM element for a truck result item.
 * @param {Object} truck - The truck data object.
 * @returns {HTMLElement}
 * @private
 */
function _createTruckResultItem(truck) {
    const item = document.createElement('div');
    item.className = 'result-item';
    const placeholderImg = 'https://via.placeholder.com/80x80.png?text=No+Image';
    let availabilityStatusHTML = '';
    const hasLocation = truck.lng !== undefined && truck.lat !== undefined;

    if (truck.isAvailable === false) {
        item.classList.add('result-item--unavailable');
        availabilityStatusHTML = `<span class="result-item-status unavailable">Currently Unavailable</span>`;
    } else if (truck.isAvailable === true && !hasLocation) {
        item.classList.add('result-item--available-no-location');
        availabilityStatusHTML = `<span class="result-item-status available-for-booking">Available for Booking</span>`;
    }

    item.innerHTML = `
        <img src="${truck.thumbnailUrl || placeholderImg}" alt="${truck.name || 'Food Truck'}" class="result-item-thumbnail">
        <div class="result-item-details">
            <h5 class="result-item-name">${truck.name || 'Unnamed Truck'}</h5>
            <p class="result-item-class" style="font-size: 0.85em; color: #666; margin: 2px 0;"><strong>Type:</strong> ${truck.vehicleClass || 'Not specified'}</p>
            <p class="result-item-description">${truck.description || 'No description available.'}</p>
            ${availabilityStatusHTML}
        </div>
    `;

    if (hasLocation) {
        item.addEventListener('click', () => {
            const currentActive = resultsContainer.querySelector('.result-item.active');
            if (currentActive) {
                currentActive.classList.remove('active');
            }
            item.classList.add('active');
    
            focusMapMarker(truck.lng, truck.lat);
        });
    } else {
        // The CSS class `.result-item--available-no-location` can be styled to have `cursor: default`.
    }

    return item;
}

/**
 * Creates a DOM element for a load result item.
 * @param {Object} load - The load data object.
 * @returns {HTMLElement}
 * @private
 */
function _createLoadResultItem(load) {
    const item = document.createElement('div');
    item.className = 'result-item result-item--load';

    const distanceInfo = load.distance ? `<span class="result-item-distance">(${load.distance.toFixed(1)} mi to pickup)</span>` : '';

    item.innerHTML = `
        <div class="result-item-details">
            <h5 class="result-item-name">Load: ${load.title || 'Untitled Load'}</h5>
            <div class="result-item-route" style="font-size: 0.9em;">
                <p style="margin: 0;"><strong>From:</strong> ${load.pickupAddress || 'N/A'} ${distanceInfo}</p>
                <p style="margin: 0;"><strong>To:</strong> ${load.deliveryAddress || 'N/A'}</p>
            </div>
            <p class="result-item-class" style="font-size: 0.85em; color: #666; margin: 2px 0;"><strong>Requires:</strong> ${load.requiredVehicleClass || 'Any Vehicle'}</p>
        </div>
    `;

    // Loads have pickup locations, so they can be focused on the map.
    if (load.lng !== undefined && load.lat !== undefined) {
        item.addEventListener('click', () => {
            const currentActive = resultsContainer.querySelector('.result-item.active');
            if (currentActive) {
                currentActive.classList.remove('active');
            }
            item.classList.add('active');
            focusMapMarker(load.lng, load.lat); // Assumes load lng/lat is the pickup location
        });
    }
    return item;
}