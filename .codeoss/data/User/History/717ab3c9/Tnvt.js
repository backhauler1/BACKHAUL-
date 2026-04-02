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

    setupServiceWorkerMessaging();
    setupGlobalComponents();
    initializePageComponents();
    initializeActiveTracking();

    setupPullToRefresh(refreshPageData);
    refreshPageData();
});

/**
 * Listens for messages from the Service Worker (e.g., Background Sync updates)
 */
function setupServiceWorkerMessaging() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data?.type === 'SYNC_COMPLETE') {
                showNotification(event.data.message, 'success');
            } else if (event.data?.type === 'SYNC_FAILED') {
                showNotification(event.data.message, 'error');
            }
        });
    }
}

/**
 * Global initializations that run on every page
 */
function setupGlobalComponents() {
    initializeTheme();
    initializeLanguageSelector();
    setupNetworkMonitoring();
    setupServiceWorkerUpdates();
    setupIosInstallPrompt();
}

/**
 * Page-specific UI component initializations based on DOM queries
 */
function initializePageComponents() {
    if (document.getElementById('chatBox')) initializeChatPage();
    if (document.querySelector('form')) setupAllForms();
    if (document.querySelector('.map-container')) initializeAllMaps();
    if (document.querySelector('#forgot-password-form, #reset-password-form, #change-password-form')) setupPasswordForms();
}

/**
 * Active Trip Tracking Initialization
 */
function initializeActiveTracking() {
    const trackingElement = document.getElementById('active-load-tracking');
    if (!trackingElement) return;

    const loadId = trackingElement.dataset.loadId;
    const destLat = parseFloat(trackingElement.dataset.lat);
    const destLng = parseFloat(trackingElement.dataset.lng);
    
    if (loadId && !isNaN(destLat) && !isNaN(destLng)) {
        startDriverTracking(loadId, destLat, destLng);
    }
}

/**
 * Data Fetching (Used on load and pull-to-refresh)
 */
async function refreshPageData() {
    const promises = [];

    const reviewsContainer = document.getElementById('user-reviews-container');
    if (reviewsContainer?.dataset.userId) {
        promises.push(loadUserReviews(reviewsContainer.dataset.userId, 'user-reviews-container'));
    }

    if (document.getElementById('my-trucks-container')) promises.push(initializeMyTrucksPage());
    if (document.getElementById('companies-table-body')) promises.push(initializeCompaniesAdminPage());

    const bidsContainer = document.getElementById('bids-container');
    if (bidsContainer?.dataset.loadId) {
        promises.push(loadBids(bidsContainer.dataset.loadId, 'bids-container'));
    }

    const complianceContainer = document.getElementById('compliance-documents-container');
    if (complianceContainer?.dataset.companyId) {
        const isAdmin = document.body.dataset.isAdmin === 'true';
        promises.push(loadComplianceDocuments(complianceContainer.dataset.companyId, 'compliance-documents-container', isAdmin));
    }
    
    // Add a small synthetic delay so the refresh animation is visible even on fast networks
    promises.push(new Promise(resolve => setTimeout(resolve, 600)));

    await Promise.all(promises);
    try {
        const results = await Promise.allSettled(promises);

        // After all promises have settled, we can check for any that were rejected.
        // This makes the data loading more robust, as a failure in one component
        // (e.g., loading bids) won't prevent other components (e.g., loading documents)
        // from rendering.
        for (const result of results) {
            if (result.status === 'rejected') {
                console.error('A data refresh operation failed:', result.reason);
            }
        }
    } catch (error) {
        // This would catch a more fundamental error with the Promise.allSettled call itself.
        console.error('A critical error occurred during the page data refresh:', error);
        showNotification('Could not refresh all page data.', 'error');
    }
}

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

/**
 * Implements a custom "Pull to Refresh" behavior for mobile devices.
 */
function setupPullToRefresh(onRefresh) {
    // Prevent the native browser pull-to-refresh to avoid double spinners
    document.body.style.overscrollBehaviorY = 'contain';

    let startY = 0;
    let pullDistance = 0;
    const threshold = 70; // pixels required to trigger a refresh

    // Create the visual indicator
    const p2rIndicator = document.createElement('div');
    p2rIndicator.id = 'p2r-indicator';
    p2rIndicator.style.cssText = 'position: fixed; top: -50px; left: 0; width: 100%; height: 50px; display: flex; justify-content: center; align-items: center; background: transparent; color: #007bff; font-weight: bold; z-index: 10000; transition: top 0.2s; pointer-events: none;';
    p2rIndicator.innerHTML = '<span>↓ Pull to refresh</span>';
    document.body.appendChild(p2rIndicator);

    window.addEventListener('touchstart', (e) => {
        // Only track pulls if the user is at the absolute top of the page
        if (window.scrollY <= 0) {
            startY = e.touches[0].clientY;
        }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
        if (window.scrollY <= 0 && startY > 0) {
            const currentY = e.touches[0].clientY;
            pullDistance = currentY - startY;

            // Only react if pulling downwards
            if (pullDistance > 0) {
                p2rIndicator.style.transition = 'none'; // Follow finger exactly
                p2rIndicator.style.top = `${Math.min(pullDistance - 50, 20)}px`;
                
                p2rIndicator.innerHTML = pullDistance > threshold 
                    ? '<span>↻ Release to refresh</span>' 
                    : '<span>↓ Pull to refresh</span>';
            }
        }
    }, { passive: true });

    window.addEventListener('touchend', async () => {
        if (pullDistance > threshold) {
            p2rIndicator.style.transition = 'top 0.2s';
            p2rIndicator.style.top = '20px';
            p2rIndicator.innerHTML = '<span>↻ Refreshing...</span>';
            
            if (onRefresh) {
                await onRefresh();
                p2rIndicator.style.transition = 'top 0.2s';
                p2rIndicator.style.top = '-50px';
            } else {
                window.location.reload();
            }
        } else {
            // Snap back up if they didn't pull far enough
            p2rIndicator.style.transition = 'top 0.2s';
            p2rIndicator.style.top = '-50px';
        }
        
        // Reset state
        startY = 0;
        pullDistance = 0;
    }, { passive: true });
}

/**
 * Detects iOS devices and shows a custom "Add to Home Screen" prompt,
 * since iOS Safari does not support the native beforeinstallprompt event.
 */
function setupIosInstallPrompt() {
    // Detect if the device is on iOS (including newer iPads that request desktop sites)
    const isIos = () => {
        const userAgent = window.navigator.userAgent.toLowerCase();
        const isMacWithTouch = /macintosh/.test(userAgent) && navigator.maxTouchPoints > 1;
        return /iphone|ipad|ipod/.test(userAgent) || isMacWithTouch;
    };

    // Detect if the app is already installed (standalone mode)
    const isStandalone = () => {
        return ('standalone' in window.navigator && window.navigator.standalone) || 
               window.matchMedia('(display-mode: standalone)').matches;
    };

    // Check if we've already prompted the user recently
    const hasPrompted = localStorage.getItem('ios_install_prompted');

    if (isIos() && !isStandalone() && !hasPrompted) {
        const promptDiv = document.createElement('div');
        promptDiv.id = 'ios-install-prompt';
        promptDiv.style.cssText = 'position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background-color: rgba(255, 255, 255, 0.95); color: #333; padding: 15px 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); z-index: 10002; display: flex; flex-direction: column; align-items: center; text-align: center; max-width: 80%; font-family: sans-serif; border: 1px solid #ddd; backdrop-filter: blur(10px);';
        
        // The SVG creates an approximate replica of the Apple Share icon
        promptDiv.innerHTML = `
            <p style="margin: 0 0 10px 0; font-size: 0.95em; line-height: 1.4;">Install this app on your iPhone: tap <svg width="18" height="22" viewBox="0 0 50 50" style="vertical-align: middle; margin: 0 4px;"><path d="M25,2 L25,32 M15,12 L25,2 L35,12 M10,25 L10,45 L40,45 L40,25" fill="none" stroke="#007bff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> and then <strong>"Add to Home Screen"</strong>.</p>
            <button id="close-ios-prompt" style="background-color: transparent; border: 1px solid #ccc; padding: 5px 15px; border-radius: 15px; font-size: 0.85em; color: #555; cursor: pointer;">Dismiss</button>
        `;

        document.body.appendChild(promptDiv);

        document.getElementById('close-ios-prompt').addEventListener('click', () => {
            promptDiv.remove();
            // Save to localStorage so they aren't prompted again on this device
            localStorage.setItem('ios_install_prompted', 'true');
        });

        // Auto-dismiss after 15 seconds to stay out of the user's way
        setTimeout(() => {
            if (document.body.contains(promptDiv)) promptDiv.remove();
        }, 15000);
    }
}