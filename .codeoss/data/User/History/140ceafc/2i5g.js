/**
 * @jest-environment jsdom
 */

import { registerPasskey, loginWithPasskey } from './webauthn';
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
        
        // Safely mock window.location to capture redirects
        originalLocation = window.location;
        delete window.location;
        window.location = { href: '' };
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        window.location = originalLocation;
        jest.restoreAllMocks();
    });

    describe('registerPasskey', () => {
        it('should successfully complete the passkey registration flow', async () => {
            // Step 1: Mock fetching the options from your server
            apiFetch.mockResolvedValueOnce({ challenge: 'mock_registration_challenge' });
            
            // Step 2: Mock the browser's successful biometric/hardware scan
            startRegistration.mockResolvedValueOnce({ id: 'mock_new_credential_id' });
            
            // Step 3: Mock the server successfully verifying the new credential
            apiFetch.mockResolvedValueOnce({ verified: true });

            await registerPasskey();

            expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/auth/webauthn/register/generate-options', { method: 'GET' });
            expect(startRegistration).toHaveBeenCalledWith({ challenge: 'mock_registration_challenge' });
            expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/auth/webauthn/register/verify', {
                method: 'POST',
                body: { id: 'mock_new_credential_id' }
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
            apiFetch.mockResolvedValueOnce({ verified: false, message: 'Invalid signature detected.' });

            await registerPasskey();

            expect(showNotification).toHaveBeenCalledWith('Verification failed: Invalid signature detected.', 'error');
        });
    });

    describe('loginWithPasskey', () => {
        it('should require an email address before attempting login', async () => {
            await loginWithPasskey(''); // Pass empty email
            expect(showNotification).toHaveBeenCalledWith('Please enter your email address first to look up your passkeys.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should successfully authenticate via passkey and redirect to dashboard', async () => {
            // Mock server -> browser -> server roundtrip
            apiFetch.mockResolvedValueOnce({ challenge: 'mock_auth_challenge' });
            startAuthentication.mockResolvedValueOnce({ id: 'mock_auth_id' });
            apiFetch.mockResolvedValueOnce({ message: 'Logged in successfully!' });

            await loginWithPasskey('test@example.com');

            expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/auth/webauthn/login/generate-options', {
                method: 'POST',
                body: { email: 'test@example.com' }
            });
            expect(startAuthentication).toHaveBeenCalledWith({ challenge: 'mock_auth_challenge' });
            expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/auth/webauthn/login/verify', {
                method: 'POST',
                body: { email: 'test@example.com', response: { id: 'mock_auth_id' } }
            });
            expect(showNotification).toHaveBeenCalledWith('Logged in successfully!', 'success');

            // Fast-forward fake timers by 1500ms to verify the redirect happened
            expect(window.location.href).toBe('');
            jest.advanceTimersByTime(1500);
            expect(window.location.href).toBe('/dashboard');
        });
    });
});