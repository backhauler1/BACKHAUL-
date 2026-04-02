import { showNotification } from './notifications.js';
import { apiFetch } from './apiUtil.js';

/**
 * Initializes password-related forms on the page.
 * This acts as a dispatcher for form-specific setup functions.
 */
export function setupPasswordForms() {
    const forgotPasswordForm = document.getElementById('forgot-password-form');
    if (forgotPasswordForm) {
        setupForgotPasswordForm(forgotPasswordForm);
    }

    const resetPasswordForm = document.getElementById('reset-password-form');
    if (resetPasswordForm) {
        setupResetPasswordForm(resetPasswordForm);
    }

    const changePasswordForm = document.getElementById('change-password-form');
    if (changePasswordForm) {
        setupChangePasswordForm(changePasswordForm);
    }
}

/**
 * Sets up the "Forgot Password" form with async submission.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupForgotPasswordForm(formElement) {
    formElement.addEventListener('submit', async (e) => {
        e.preventDefault();

        const emailInput = formElement.querySelector('input[name="email"]');
        const email = emailInput ? emailInput.value : '';

        if (!email) {
            showNotification('Please enter your email address.', 'warning');
            return;
        }

        const submitButton = formElement.querySelector('button[type="submit"]');
        const originalButtonText = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = 'Sending...';

        try {
            const data = await apiFetch('/api/auth/forgot-password', {
                method: 'POST',
                body: { email },
            });

            showNotification(data.message, 'success');
            formElement.reset(); // Clear the form

        } catch (error) {
            console.error('Forgot Password Frontend Error:', error);
            showNotification(`Error: ${error.message}`, 'error');
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = originalButtonText;
        }
    });
}

/**
 * Sets up the "Change Password" form for logged-in users.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupChangePasswordForm(formElement) {
    formElement.addEventListener('submit', async (e) => {
        e.preventDefault();

        const currentPasswordInput = formElement.querySelector('input[name="currentPassword"]');
        const newPasswordInput = formElement.querySelector('input[name="newPassword"]');
        const confirmPasswordInput = formElement.querySelector('input[name="confirmPassword"]');

        const currentPassword = currentPasswordInput ? currentPasswordInput.value : '';
        const newPassword = newPasswordInput ? newPasswordInput.value : '';
        const confirmPassword = confirmPasswordInput ? confirmPasswordInput.value : '';

        if (!currentPassword || !newPassword || !confirmPassword) {
            return showNotification('Please fill out all fields.', 'warning');
        }
        if (newPassword !== confirmPassword) {
            return showNotification('New passwords do not match.', 'warning');
        }
        if (newPassword.length < 8) {
            return showNotification('New password must be at least 8 characters long.', 'warning');
        }

        const submitButton = formElement.querySelector('button[type="submit"]');
        const originalButtonText = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = 'Updating...';

        try {
            const data = await apiFetch('/api/auth/change-password', {
                method: 'POST',
                body: { currentPassword, newPassword },
            });
            showNotification(data.message, 'success');
            formElement.reset(); // Clear the form
            
            // Redirect to login page since the session was terminated
            setTimeout(() => {
                window.location.href = '/login';
            }, 2500);
        } catch (error) {
            console.error('Change Password Frontend Error:', error);
            showNotification(`Error: ${error.message}`, 'error');
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = originalButtonText;
        }
    });
}

/**
 * Sets up the "Reset Password" form with async submission.
 * Extracts token and email from URL parameters.
 * @param {HTMLFormElement} formElement The form element to attach the listener to.
 */
function setupResetPasswordForm(formElement) {
    // Extract token and email from URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    const email = urlParams.get('email');

    if (!token || !email) {
        showNotification('Invalid or missing password reset link. Please request a new one.', 'error');
        // Optionally, redirect to the forgot password page
        // window.location.href = '/forgot-password';
        return;
    }

    formElement.addEventListener('submit', async (e) => {
        e.preventDefault();

        const newPasswordInput = formElement.querySelector('input[name="newPassword"]');
        const newPassword = newPasswordInput ? newPasswordInput.value : '';

        if (!newPassword || newPassword.length < 8) {
            showNotification('New password must be at least 8 characters long.', 'warning');
            return;
        }

        const submitButton = formElement.querySelector('button[type="submit"]');
        const originalButtonText = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = 'Resetting...';

        try {
            const data = await apiFetch('/api/auth/reset-password', {
                method: 'POST',
                body: { token, email, newPassword },
            });

            showNotification(data.message, 'success');
            formElement.reset(); // Clear the form
            // Optional: Redirect to login page after successful reset
            // setTimeout(() => { window.location.href = '/login'; }, 3000);
        } catch (error) {
            console.error('Reset Password Frontend Error:', error);
            showNotification(`Error: ${error.message}`, 'error');
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = originalButtonText;
        }
    });
}