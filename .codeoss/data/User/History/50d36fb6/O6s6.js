import { focusMapMarker } from './mapbox_maps.js';

/**
 * Manages the rendering of search results into a list view.
 */

// A reference to the container where results will be displayed.
// Assumes an element with this ID exists in the HTML, e.g., <div id="results-list-container"></div>
const resultsContainer = document.getElementById('results-list-container');

/**
 * Renders or appends a list of truck results to the DOM.
 * @param {Array<Object>} results - The array of truck data from the API.
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
    results.forEach(truck => {
        const resultItem = _createResultItemElement(truck);
        fragment.appendChild(resultItem);
    });

    resultsContainer.appendChild(fragment);
}

/**
 * Creates a single DOM element for a truck result item.
 * @param {Object} truck - The truck data object.
 * @returns {HTMLElement}
 * @private
 */
function _createResultItemElement(truck) {
    const item = document.createElement('div');
    // Add CSS classes for styling. You'll need to define these in your CSS file.
    item.className = 'result-item';
    // NOTE: This assumes your API response includes `name`, `description`, `isAvailable` and optionally `thumbnailUrl`.
    const placeholderImg = 'https://via.placeholder.com/80x80.png?text=No+Image';
    let availabilityStatusHTML = '';
    const hasLocation = truck.lng !== undefined && truck.lat !== undefined;

    // Determine availability status and apply classes
    if (truck.isAvailable === false) {
        item.classList.add('result-item--unavailable');
        availabilityStatusHTML = `<span class="result-item-status unavailable">Currently Unavailable</span>`;
    } else if (truck.isAvailable === true && !hasLocation) {
        // This is the new state: Available, but location is private (e.g., for booking).
        item.classList.add('result-item--available-no-location');
        availabilityStatusHTML = `<span class="result-item-status available-for-booking">Available for Booking</span>`;
    }

    item.innerHTML = `
        <img src="${truck.thumbnailUrl || placeholderImg}" alt="${truck.name || 'Food Truck'}" class="result-item-thumbnail">
        <div class="result-item-details">
            <h5 class="result-item-name">${truck.name || 'Unnamed Truck'}</h5>
            <p class="result-item-description">${truck.description || 'No description available.'}</p>
            ${availabilityStatusHTML}
        </div>
    `;

    // Add a click event to focus the map, but only if the truck has a public location.
    if (hasLocation) {
        item.addEventListener('click', () => {
            // Remove the 'active' class from any previously selected item
            const currentActive = resultsContainer.querySelector('.result-item.active');
            if (currentActive) {
                currentActive.classList.remove('active');
            }
            // Add the 'active' class to the newly clicked item
            item.classList.add('active');
    
            focusMapMarker(truck.lng, truck.lat);
        });
    } else {
        // For items without a location, make it clear they are not interactive in a map context.
        // The chat button will still work if available, but clicking the item itself does nothing.
        item.style.cursor = 'default';
        // The CSS class `.result-item--available-no-location` now handles the cursor style.
    }

    return item;
}