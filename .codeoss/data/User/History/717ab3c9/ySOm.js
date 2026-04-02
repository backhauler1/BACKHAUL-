import { initializeChatPage } from './chat.js';
import { initializeTheme } from './theme.js';
import { setupAllForms } from './forms.js';
// Import CSS so esbuild bundles and minifies it automatically
import { setupPasswordForms } from './passwordForms.js';
import './notifications.css';
import { initializeAllMaps } from './mapbox_maps.js';
import { startDriverTracking } from './driverTracking.js';
import { loadUserReviews } from './profileReviews.js';

/**
 * Main application entry point.
 * This script should be included in your HTML with `type="module"`.
 * It dispatches initialization functions based on the content of the current page.
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log('App loaded via ES6 module.');

    // --- Global initializations (run on every page) ---
    initializeTheme();

    // --- Page-specific initializations ---

    // If a chat box is found, initialize the chat page logic.
    if (document.getElementById('chatBox')) {
        initializeChatPage();
    }

    // Initialize any forms present on the page.
    // setupAllForms() has internal checks, so it's safe to call once.
    if (document.querySelector('#find-truck-form, #find-load-form, #find-company-form, #register-company-form, #post-load-form, #rating-form')) {
        setupAllForms();
    }

    // If map containers are present, initialize them.
    if (document.querySelector('.map-container')) {
        initializeAllMaps();
    }

    // Initialize password forms if present
    if (document.querySelector('#forgot-password-form, #reset-password-form, #change-password-form')) {
        setupPasswordForms();
    }

    // --- Active Trip Tracking ---
    // If an element exists with these data attributes, trigger the Geofencing tracker.
    // Example HTML: <div id="active-load-tracking" data-load-id="12" data-lat="34.05" data-lng="-118.24"></div>
    const trackingElement = document.getElementById('active-load-tracking');
    if (trackingElement) {
        const loadId = trackingElement.dataset.loadId;
        const destLat = parseFloat(trackingElement.dataset.lat);
        const destLng = parseFloat(trackingElement.dataset.lng);
        if (loadId && !isNaN(destLat) && !isNaN(destLng)) {
            startDriverTracking(loadId, destLat, destLng);
        }
    }

    // --- User Profile Reviews ---
    const reviewsContainer = document.getElementById('user-reviews-container');
    if (reviewsContainer && reviewsContainer.dataset.userId) {
        loadUserReviews(reviewsContainer.dataset.userId, 'user-reviews-container');
    }
});