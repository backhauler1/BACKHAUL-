/**
 * @jest-environment jsdom
 */

import { 
    registerPasskey, 
    loginWithPasskey, 
    setupPasskeyRegistrationBtn, 
    setupPasskeyLoginBtn 
} from './webauthn';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

// 1. Mock internal utilities
jest.mock('./apiUtil', () => ({ apiFetch: jest.fn() }));
jest.mock('./notifications', () => ({ showNotification: jest.fn() }));

// 2. Mock the SimpleWebAuthn browser library
jest.mock('@simplewebauthn/browser', () => ({
    startRegistration: jest.fn(),
    startAuthentication: jest.fn()
}));

describe('WebAuthn Frontend Logic (webauthn.js)', () => {
    let originalLocation;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers(); // Intercept setTimeouts for fast redirect testing
        jest.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console.error in tests
        
        originalLocation = window.location;
        delete window.location;
        window.location = { 
            _href: 'http://localhost/', 
            get href() { return this._href; },
            set href(val) { this._href = val; },
            assign: jest.fn(), 
            reload: jest.fn(),
            replace: jest.fn(),
            toString: function() { return this.href; }
        };
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        window.location = originalLocation;
    });

    describe('registerPasskey', () => {
        it('should successfully complete the passkey registration flow', async () => {
            // Step 1: Mock fetching the options from your server
            apiFetch.mockResolvedValueOnce({ challenge: 'mock_registration_challenge' });
            
            // Step 2: Mock the browser's successful biometric/hardware scan
            startRegistration.mockResolvedValueOnce({ id: 'mock_new_credential_id' });
            
            // Step 3: Mock the server successfully verifying the new credential
            apiFetch.mockResolvedValueOnce({ status: 'ok' });

            await registerPasskey();

            expect(apiFetch).toHaveBeenNthCalledWith(1, '/generate-registration-options', { method: 'POST' });
            expect(startRegistration).toHaveBeenCalledWith({ challenge: 'mock_registration_challenge' });
            expect(apiFetch).toHaveBeenNthCalledWith(2, '/verify-registration', {
                method: 'POST',
                body: { id: 'mock_new_credential_id' },
            });
            expect(showNotification).toHaveBeenCalledWith('Passkey registered successfully! You can now use it to log in.', 'success');
        });

        it('should gracefully handle the user canceling the TouchID/FaceID prompt (NotAllowedError)', async () => {
            apiFetch.mockResolvedValueOnce({ challenge: 'mock_registration_challenge' });
            
            // Simulate the user clicking "Cancel" on the native OS prompt
            const cancelError = new Error('The operation either timed out or was not allowed.');
            cancelError.name = 'NotAllowedError';
            startRegistration.mockRejectedValueOnce(cancelError);

            await registerPasskey();

            expect(showNotification).toHaveBeenCalledWith('Registration cancelled by user.', 'warning');
            expect(apiFetch).toHaveBeenCalledTimes(1); // Verify phase should be completely skipped
        });

        it('should display an error if the server verification fails', async () => {
            apiFetch.mockResolvedValueOnce({ challenge: 'mock_registration_challenge' });
            startRegistration.mockResolvedValueOnce({ id: 'mock_new_credential_id' });
            apiFetch.mockResolvedValueOnce({ status: 'failed', error: 'Invalid signature detected.' });

            await registerPasskey();

            expect(showNotification).toHaveBeenCalledWith('Verification failed: Invalid signature detected.', 'error');
        });

    describe('DOM Setup Interactions', () => {
        let registerBtn;
        let loginBtn;
        let usernameInput;

        beforeEach(() => {
            // 1. Setup a fake DOM environment
            document.body.innerHTML = `
                <input type="text" id="passkey-username-input" />
                <button id="register-passkey-btn">Register New Passkey</button>
                <button id="login-passkey-btn">Log in with Passkey</button>
            `;
            registerBtn = document.getElementById('register-passkey-btn');
            loginBtn = document.getElementById('login-passkey-btn');
            usernameInput = document.getElementById('passkey-username-input');
        });

        it('should disable the registration button and update text when clicked', async () => {
            setupPasskeyRegistrationBtn(registerBtn);
            
            // Mock the API calls so the async function succeeds seamlessly
            apiFetch.mockResolvedValueOnce({ challenge: 'mock_challenge' });
            startRegistration.mockResolvedValueOnce({ id: 'mock_id' });
            apiFetch.mockResolvedValueOnce({ status: 'ok' }); // For verify-registration

            // Trigger the click event synchronously
            registerBtn.click();
            
            // Immediately after click, button should update its UI state
            expect(registerBtn.disabled).toBe(true);
            expect(registerBtn.textContent).toBe('Awaiting Device Prompt...');

            // Allow async operations and timers to complete
            await new Promise(process.nextTick);
            await jest.advanceTimersByTimeAsync(2000);

            expect(window.location.reload).toHaveBeenCalled();
        });

        it('should extract username from input and restore button state on login failure', async () => {
            setupPasskeyLoginBtn(loginBtn, usernameInput);
            usernameInput.value = 'testuser';
            
            // Force a rejection to test the button cleanup/restore logic
            apiFetch.mockRejectedValueOnce(new Error('Network error'));

            loginBtn.click();

            // Flush the microtask queue so the async event handler has time to finish execution
            for (let i = 0; i < 5; i++) {
                await Promise.resolve();
            }
            
            // Verify that the username was correctly extracted and passed to the API
            expect(apiFetch).toHaveBeenCalledWith('/generate-auth-options', {
                method: 'POST', body: { username: 'testuser' }
            });
            
            // The button should be restored to its original state after a failure
            expect(loginBtn.disabled).toBe(false);
            expect(loginBtn.textContent).toBe('Log in with Passkey');
        });
    });
    });

    describe('loginWithPasskey', () => {
        it('should require an email address before attempting login', async () => {
            await loginWithPasskey(''); // Pass empty email
            expect(showNotification).toHaveBeenCalledWith('Please enter your username first to look up your passkeys.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should successfully authenticate via passkey and redirect to dashboard', async () => {
            // Mock server -> browser -> server roundtrip
            apiFetch.mockResolvedValueOnce({ challenge: 'mock_auth_challenge' });
            startAuthentication.mockResolvedValueOnce({ id: 'mock_auth_id' });
            apiFetch.mockResolvedValueOnce({ status: 'ok', redirect: '/dashboard' });

            await loginWithPasskey('test@example.com');

            expect(apiFetch).toHaveBeenNthCalledWith(1, '/generate-auth-options', {
                method: 'POST',
                body: { username: 'test@example.com' }
            });
            expect(startAuthentication).toHaveBeenCalledWith({ challenge: 'mock_auth_challenge' });
            expect(apiFetch).toHaveBeenNthCalledWith(2, '/verify-auth', {
                method: 'POST',
                body: { id: 'mock_auth_id' }
            });
            expect(showNotification).toHaveBeenCalledWith('Logged in successfully!', 'success');

            // Fast-forward fake timers by 1500ms to verify the redirect happened
            await new Promise(process.nextTick);
            await jest.advanceTimersByTimeAsync(2000);
            expect(window.location.href).toContain('/dashboard');
        });
    });
});