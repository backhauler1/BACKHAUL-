/**
 * Initializes the theme switcher functionality.
 * It applies the saved theme on load and adds a click listener to the toggle button.
 */
export function initializeTheme() {
    const themeToggleBtn = document.getElementById('theme-toggle');
    if (!themeToggleBtn) return; // Don't run if the toggle button isn't on the page

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
        const currentTheme = document.documentElement.hasAttribute('data-theme') ? 'dark' : 'light';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        _setTheme(newTheme, themeToggleBtn);
        localStorage.setItem('theme', newTheme);
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