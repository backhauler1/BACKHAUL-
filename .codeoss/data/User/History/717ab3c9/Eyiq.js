import { initializeChatPage } from './chat.js';
import { initializeTheme } from './theme.js';
import { setupAllForms } from './forms.js';
// Import CSS so esbuild bundles and minifies it automatically
import { setupPasswordForms } from './passwordForms.js';
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

    // Initialize any forms present on the page.
    // setupAllForms() has internal checks, so it's safe to call once.
    if (document.querySelector('#find-truck-form, #find-load-form, #find-company-form, #register-company-form')) {
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
});