import { initializeChatPage } from './chat.js';
import { initializeTheme } from './theme.js';
import { setupAllForms } from './forms.js';
// Import CSS so esbuild bundles and minifies it automatically
import { setupPasswordForms } from './passwordForms.js';
import './notifications.css';
import { initializeAllMaps } from './mapbox_maps.js';
import { startDriverTracking } from './driverTracking.js';
import { loadUserReviews } from './profileReviews.js';
import { initializeCompaniesAdminPage } from './adminCompanies.js';
import { loadBids } from './bids.js';
import { loadComplianceDocuments } from './compliance.js';
import { initializeLanguageSelector } from './languageSelector.js';
import { initPromise } from './i18n.js';
import { initializeMyTrucksPage } from './myTrucks.js';
import { showNotification } from './notifications.js';

/**
 * Main application entry point.
 * This script should be included in your HTML with `type="module"`.
 * It dispatches initialization functions based on the content of the current page.
 */
document.addEventListener('DOMContentLoaded', async () => {
    // Wait for the translations to be loaded over the network before initializing UI components
    await initPromise;

    console.log('App loaded via ES6 module.');

    // --- Listen for messages from the Service Worker (e.g., Background Sync updates) ---
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'SYNC_COMPLETE') {
                showNotification(event.data.message, 'success');
            } else if (event.data && event.data.type === 'SYNC_FAILED') {
                showNotification(event.data.message, 'error');
            }
        });
    }

    // --- Global initializations (run on every page) ---
    initializeTheme();
    initializeLanguageSelector();
    setupNetworkMonitoring();
    setupServiceWorkerUpdates();

    // --- Page-specific initializations ---

    // If a chat box is found, initialize the chat page logic.
    if (document.getElementById('chatBox')) {
        initializeChatPage();
    }

    // Initialize any forms present on the page.
    // setupAllForms() has internal checks, so it's safe to call once.
    if (document.querySelector('form')) { // Simplified to run if any form exists
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

    // --- My Trucks ---
    if (document.getElementById('my-trucks-container')) {
        initializeMyTrucksPage();
    }

    // --- Admin Pages ---
    if (document.getElementById('companies-table-body')) {
        initializeCompaniesAdminPage();
    }

    // --- Load Bids ---
    const bidsContainer = document.getElementById('bids-container');
    if (bidsContainer && bidsContainer.dataset.loadId) {
        loadBids(bidsContainer.dataset.loadId, 'bids-container');
    }

    // --- Compliance Documents ---
    const complianceContainer = document.getElementById('compliance-documents-container');
    if (complianceContainer && complianceContainer.dataset.companyId) {
        const isAdmin = document.body.dataset.isAdmin === 'true';
        loadComplianceDocuments(complianceContainer.dataset.companyId, 'compliance-documents-container', isAdmin);
    }
});

/**
 * Monitors the network connection status and displays a banner when offline.
 */
function setupNetworkMonitoring() {
    const createOfflineBanner = () => {
        if (document.getElementById('offline-banner')) return;
        
        const banner = document.createElement('div');
        banner.id = 'offline-banner';
        // Styling creates a fixed banner at the very top of the viewport
        banner.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; background-color: #dc3545; color: white; text-align: center; padding: 10px; font-weight: bold; z-index: 10000; box-shadow: 0 2px 4px rgba(0,0,0,0.2);';
        banner.textContent = 'You are currently offline. Some features may be unavailable.';
        
        document.body.appendChild(banner);
    };

    const removeOfflineBanner = () => {
        const banner = document.getElementById('offline-banner');
        if (banner) {
            banner.remove();
            showNotification('You are back online!', 'success');
        }
    };

    window.addEventListener('offline', createOfflineBanner);
    window.addEventListener('online', removeOfflineBanner);

    // Check the initial state on page load (in case they load the page from the Service Worker cache while offline)
    if (!navigator.onLine) createOfflineBanner();
}

/**
 * Monitors for Service Worker updates and displays an "Update Available" banner.
 */
function setupServiceWorkerUpdates() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/service-worker.js').then(registration => {
        // If there's already a waiting update, show the banner
        if (registration.waiting) {
            showUpdateBanner(registration.waiting);
        }

        // Listen for new updates being installed
        registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (!newWorker) return;

            newWorker.addEventListener('statechange', () => {
                // Only show the banner if there's an existing controller (meaning it's an update, not the first install)
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    showUpdateBanner(newWorker);
                }
            });
        });
    }).catch(err => console.error('Service Worker registration failed:', err));

    // Reload the page when the new service worker takes over
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
            refreshing = true;
            window.location.reload();
        }
    });

    function showUpdateBanner(newWorker) {
        if (document.getElementById('update-banner')) return;

        const banner = document.createElement('div');
        banner.id = 'update-banner';
        banner.style.cssText = 'position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background-color: #333; color: white; padding: 15px 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); z-index: 10001; display: flex; align-items: center; gap: 15px; font-family: sans-serif;';

        banner.innerHTML = `
            <span>A new version of the app is available!</span>
            <button id="update-now-btn" style="background-color: #007bff; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; font-weight: bold;">Update Now</button>
            <button id="close-update-btn" style="background: transparent; color: white; border: none; font-size: 1.2em; cursor: pointer; padding: 0; line-height: 1;">&times;</button>
        `;

        document.body.appendChild(banner);

        document.getElementById('update-now-btn').addEventListener('click', (e) => {
            e.target.disabled = true;
            e.target.textContent = 'Updating...';
            // Tell the new service worker to skip the waiting phase
            newWorker.postMessage({ action: 'skipWaiting' });
        });

        document.getElementById('close-update-btn').addEventListener('click', () => {
            banner.remove();
        });
    }
}