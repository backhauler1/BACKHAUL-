/*
    Global Notification System
    Provides a function to show toast-style notifications on the screen.
*/

/**
 * Displays a toast notification on the screen.
 * @param {string} message - The message to display.
 * @param {string} [type='info'] - The type of notification ('success', 'error', 'warning', 'info').
 * @param {number} [duration=5000] - How long the notification should be visible in milliseconds.
 */
function showNotification(message, type = 'info', duration = 5000) {
    const container = document.getElementById('notification-container');
    if (!container) {
        console.error('Notification container not found in the DOM!');
        return;
    }

    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;

    const closeButton = document.createElement('button');
    closeButton.className = 'close-btn';
    closeButton.innerHTML = '&times;'; // '×' symbol
    closeButton.onclick = () => {
        notification.classList.add('fade-out');
        notification.addEventListener('animationend', () => notification.remove());
    };
    notification.appendChild(closeButton);

    container.appendChild(notification);

    setTimeout(() => {
        if (notification.parentElement) {
            notification.classList.add('fade-out');
            notification.addEventListener('animationend', () => notification.remove());
        }
    }, duration);
}