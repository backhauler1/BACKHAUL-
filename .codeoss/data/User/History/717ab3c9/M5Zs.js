import { initializeChatPage } from './chat.js';
import { initializeTheme } from './theme.js';
import { setupAllForms } from './forms.js';
// Import CSS so esbuild bundles and minifies it automatically
import './notifications.css';
import { initializeAllMaps } from './mapbox_maps.js';

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

    // Example: If a "find-truck-form" is found, initialize forms.
    if (document.getElementById('find-truck-form')) {
        setupAllForms();
    }
    
    // If a "find-load-form" is found, initialize forms (handled by setupAllForms).
    if (document.getElementById('find-load-form') && !document.getElementById('find-truck-form')) {
        setupAllForms();
    }

    // If map containers are present, initialize them.
    if (document.querySelector('.map-container')) {
        initializeAllMaps();
    }
});