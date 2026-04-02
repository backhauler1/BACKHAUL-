import { showNotification } from './notifications.js';

/**
 * Initializes the theme switcher functionality.
 * It applies the saved theme on load and adds a click listener to the toggle button.
 */
export function initializeTheme() {
    const themeToggleBtn = document.getElementById('theme-toggle');
    if (!themeToggleBtn) return; // Don't run if the toggle button isn't on the page

    // Inject transition styles dynamically to avoid flash on initial load
    const style = document.createElement('style');
    style.textContent = `
        .theme-transition,
        .theme-transition *,
        .theme-transition *:before,
        .theme-transition *:after {
            transition: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease, fill 0.3s ease, stroke 0.3s ease !important;
        }
    `;
    document.head.appendChild(style);

    // Apply the initial theme based on saved preference or OS setting
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (savedTheme) {
        _setTheme(savedTheme, themeToggleBtn);
    } else {
        _setTheme(prefersDark ? 'dark' : 'light', themeToggleBtn);
    }

    // Handle button click to toggle the theme
    themeToggleBtn.addEventListener('click', () => {
        // Add transition class to document root to enable the animation
        document.documentElement.classList.add('theme-transition');

        const currentTheme = document.documentElement.hasAttribute('data-theme') ? 'dark' : 'light';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        _setTheme(newTheme, themeToggleBtn);
        localStorage.setItem('theme', newTheme);

        // Save the preference to the database for logged-in users
        _saveThemePreference(newTheme);

        // Remove transition class after the animation completes (300ms)
        setTimeout(() => {
            document.documentElement.classList.remove('theme-transition');
        }, 300);
    });
}

/**
 * Sets the 'data-theme' attribute and updates the toggle button's content.
 * @private
 */
function _setTheme(theme, button) {
    if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        button.innerHTML = '☀️'; // Sun icon for switching to light mode
        button.setAttribute('aria-label', 'Switch to light theme');
    } else {
        document.documentElement.removeAttribute('data-theme');
        button.innerHTML = '🌙'; // Moon icon for switching to dark mode
        button.setAttribute('aria-label', 'Switch to dark theme');
    }
}

/**
 * Saves the user's theme preference to the database via an API call.
 * This is a "fire-and-forget" call with its own error handling.
 * @private
 * @param {string} theme - The theme to save ('light' or 'dark').
 */
async function _saveThemePreference(theme) {
    // Check if the user is logged in by looking for a user ID on the body tag.
    // Your backend should render this attribute for logged-in users.
    const userId = document.body.dataset.userId;
    if (!userId) {
        return; // Not a logged-in user, do nothing.
    }

    try {
        // NOTE: If you have a centralized API wrapper (like `apiFetch`), use it here.
        const response = await fetch('/api/user/preferences', {
            method: 'PATCH', // Or 'POST', depending on your API design
            headers: {
                'Content-Type': 'application/json',
                // You may need to include a CSRF token here as well.
            },
            body: JSON.stringify({ theme: theme }),
        });

        if (!response.ok) {
            throw new Error('Server responded with an error.');
        }
    } catch (error) {
        console.error('Failed to save theme preference to account:', error);
        showNotification("Couldn't sync theme preference to your account.", 'warning');
    }
}