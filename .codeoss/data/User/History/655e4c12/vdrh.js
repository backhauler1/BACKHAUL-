import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

// Note: If you are using a bundler (Webpack, Vite, Rollup), you can import this directly.
// If you are using plain ES Modules in the browser, you might need to load this via a CDN script tag
// and access it via the global `window.SimpleWebAuthnBrowser`.
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

/**
 * Starts the Passkey registration flow for a logged-in user.
 * Attach this to a "Create Passkey" button in the user's settings profile.
 */
export async function registerPasskey() {
    try {
        // 1. Fetch the registration options from your server
        const options = await apiFetch('/api/auth/webauthn/register/generate-options', { 
            method: 'GET' 
        });

        // 2. Pass the options to the browser's WebAuthn API to trigger the FaceID/TouchID prompt
        let authResp;
        try {
            authResp = await startRegistration(options);
        } catch (error) {
            // The user cancelled the prompt or their device doesn't support WebAuthn
            if (error.name === 'NotAllowedError') {
                return showNotification('Registration cancelled by user.', 'warning');
            }
            throw error;
        }

        // 3. Send the generated credential back to the server for verification and storage
        const verification = await apiFetch('/api/auth/webauthn/register/verify', {
            method: 'POST',
            body: authResp // startRegistration returns the exact format the server expects
        });

        if (verification.verified) {
            showNotification('Passkey registered successfully! You can now use it to log in.', 'success');
        } else {
            showNotification(`Verification failed: ${verification.message}`, 'error');
        }
    } catch (error) {
        console.error('Passkey registration error:', error);
        showNotification(`Error: ${error.message}`, 'error');
    }
}

/**
 * Starts the Passkey login flow.
 * Attach this to a "Log in with Passkey" button on the login page.
 * 
 * @param {string} email - The email address typed into the login form.
 */
export async function loginWithPasskey(email) {
    if (!email) {
        return showNotification('Please enter your email address first to look up your passkeys.', 'warning');
    }

    try {
        // 1. Fetch the authentication options from your server for this specific email
        const options = await apiFetch('/api/auth/webauthn/login/generate-options', {
            method: 'POST',
            body: { email }
        });

        // 2. Pass the options to the browser to trigger the FaceID/TouchID prompt
        let authResp;
        try {
            authResp = await startAuthentication(options);
        } catch (error) {
            if (error.name === 'NotAllowedError') {
                return showNotification('Authentication cancelled by user.', 'warning');
            }
            throw error;
        }

        // 3. Verify the signed challenge with the server to issue the JWT cookies
        const verification = await apiFetch('/api/auth/webauthn/login/verify', {
            method: 'POST',
            body: { email, response: authResp }
        });

        showNotification(verification.message || 'Logged in successfully!', 'success');
        
        // 4. Redirect the user to the application
        setTimeout(() => {
            window.location.href = '/dashboard'; // Adjust the destination URL as needed
        }, 1500);

    } catch (error) {
        console.error('Passkey login error:', error);
        showNotification(`Error: ${error.message}`, 'error');
    }
}