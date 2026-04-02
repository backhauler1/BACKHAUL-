/**
 * @jest-environment jsdom
 */

import { showNotification } from './notifications';

describe('Notifications UI (notifications.js)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = '<div id="notification-container"></div>';
        // Suppress expected console.error logs for clean test output
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('should create and append a notification element with the correct type', () => {
        showNotification('Test message', 'success');
        
        const container = document.getElementById('notification-container');
        const notification = container.querySelector('.notification');
        
        expect(notification).not.toBeNull();
        expect(notification.classList.contains('notification-success')).toBe(true);
        expect(notification.textContent).toContain('Test message');
    });

    it('should add the fade-out class after the specified duration', () => {
        showNotification('Timeout test', 'info', 1000);
        
        const notification = document.querySelector('.notification');
        expect(notification.classList.contains('fade-out')).toBe(false);
        
        jest.advanceTimersByTime(1000); // Fast forward time
        
        expect(notification.classList.contains('fade-out')).toBe(true);
    });

    it('should handle the close button click', () => {
        showNotification('Closable test', 'error');
        const closeBtn = document.querySelector('.close-btn');
        
        closeBtn.click();
        expect(document.querySelector('.notification').classList.contains('fade-out')).toBe(true);
    });
});