/**
 * @jest-environment jsdom
 */

import { setupPasswordForms } from './passwordForms';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

jest.mock('./apiUtil.js', () => ({ apiFetch: jest.fn() }));
jest.mock('./notifications.js', () => ({ showNotification: jest.fn() }));

describe('Password Forms Validation (passwordForms.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        
        // Use history.pushState to mock URL parameters natively in JSDOM
        window.history.pushState({}, 'Test Title', '/?token=mock_token_123&email=test@example.com');

        // Setup the DOM with all three password forms
        document.body.innerHTML = `
            <form id="forgot-password-form">
                <input type="email" name="email" value="test@example.com">
                <button type="submit">Send Reset Link</button>
            </form>
            
            <form id="reset-password-form">
                <input type="password" name="newPassword" value="newSecurePass123">
                <button type="submit">Reset Password</button>
            </form>
            
            <form id="change-password-form">
                <input type="password" name="currentPassword" value="oldPass123">
                <input type="password" name="newPassword" value="newSecurePass123">
                <input type="password" name="confirmPassword" value="newSecurePass123">
                <button type="submit">Change Password</button>
            </form>
        `;

        setupPasswordForms();
    });

    describe('Forgot Password Form', () => {
        it('should prevent submission if email is empty', () => {
            const form = document.getElementById('forgot-password-form');
            form.querySelector('input[name="email"]').value = '';
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            
            expect(showNotification).toHaveBeenCalledWith('Please enter your email address.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should submit successfully if email is provided', async () => {
            const form = document.getElementById('forgot-password-form');
            apiFetch.mockResolvedValueOnce({ message: 'Email sent' });
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await new Promise(process.nextTick);

            expect(apiFetch).toHaveBeenCalledWith('/api/auth/forgot-password', {
                method: 'POST', 
                body: { email: 'test@example.com' }
            });
        });
    });

    describe('Reset Password Form (Initialization)', () => {
        it('should show an error if token or email is missing from URL', () => {
            // Clear the URL parameters natively
            window.history.pushState({}, 'Test Title', '/');
            // Re-run setup with the bad URL
            setupPasswordForms();

            expect(showNotification).toHaveBeenCalledWith('Invalid or missing password reset link. Please request a new one.', 'error');
        });
    });

    describe('Reset Password Form', () => {
        it('should prevent submission if the new password is less than 8 characters', () => {
            const form = document.getElementById('reset-password-form');
            form.querySelector('input[name="newPassword"]').value = 'short';
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            
            expect(showNotification).toHaveBeenCalledWith('New password must be at least 8 characters long.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should extract URL params and submit the reset request', async () => {
            const form = document.getElementById('reset-password-form');
            apiFetch.mockResolvedValueOnce({ message: 'Password reset successful' });
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await new Promise(process.nextTick);

            expect(apiFetch).toHaveBeenCalledWith('/api/auth/reset-password', {
                method: 'POST', 
                body: { token: 'mock_token_123', email: 'test@example.com', newPassword: 'newSecurePass123' }
            });
        });
    });

    describe('Change Password Form', () => {
        it('should prevent submission if any field is empty', () => {
            const form = document.getElementById('change-password-form');
            form.querySelector('input[name="currentPassword"]').value = '';

            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

            expect(showNotification).toHaveBeenCalledWith('Please fill out all fields.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should prevent submission if new password is too short', () => {
            const form = document.getElementById('change-password-form');
            form.querySelector('input[name="newPassword"]').value = 'short';
            form.querySelector('input[name="confirmPassword"]').value = 'short';

            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

            expect(showNotification).toHaveBeenCalledWith('New password must be at least 8 characters long.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should prevent submission if new passwords do not match', () => {
            const form = document.getElementById('change-password-form');
            form.querySelector('input[name="confirmPassword"]').value = 'mismatched_password';
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            
            expect(showNotification).toHaveBeenCalledWith('New passwords do not match.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should submit successfully and trigger redirect on success', async () => {
            jest.useFakeTimers();

            const originalLocation = window.location;
            delete window.location;
            window.location = { ...originalLocation, href: originalLocation.href };

            const form = document.getElementById('change-password-form');
            apiFetch.mockResolvedValueOnce({ message: 'Password has been successfully updated. Please log in again.' });

            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await jest.runAllTimersAsync();
            await new Promise(process.nextTick);

            expect(apiFetch).toHaveBeenCalledWith('/api/auth/change-password', {
                method: 'POST',
                body: { currentPassword: 'oldPass123', newPassword: 'newSecurePass123' }
            });
            expect(showNotification).toHaveBeenCalledWith('Password has been successfully updated. Please log in again.', 'success');

            // Fast-forward time to check for the redirect
            await Promise.resolve();
            jest.advanceTimersByTime(3000);
            await Promise.resolve();
            expect(window.location.href).toContain('/login');

            window.location = originalLocation;
            jest.useRealTimers();
        });

        it('should show an error if the API call fails (e.g., wrong current password)', async () => {
            const form = document.getElementById('change-password-form');
            apiFetch.mockRejectedValueOnce(new Error('Incorrect current password.'));

            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await jest.runAllTimersAsync();

            expect(apiFetch).toHaveBeenCalled();
            expect(showNotification).toHaveBeenCalledWith('Error: Incorrect current password.', 'error');
        });
    });
});