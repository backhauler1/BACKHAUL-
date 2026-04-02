document.addEventListener('DOMContentLoaded', () => {
    const themeToggleBtn = document.getElementById('theme-toggle');

    // Function to set the theme on the <html> element
    const setTheme = (theme) => {
        if (theme === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    };

    // Apply saved theme from localStorage or default to OS preference
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (savedTheme) {
        setTheme(savedTheme);
    } else {
        setTheme(prefersDark ? 'dark' : 'light');
    }

    // Handle button click to toggle the theme
    themeToggleBtn.addEventListener('click', () => {
        const currentTheme = document.documentElement.hasAttribute('data-theme') ? 'dark' : 'light';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        setTheme(newTheme);
        localStorage.setItem('theme', newTheme);
    });
});
