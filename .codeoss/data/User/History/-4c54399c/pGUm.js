import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

export async function showOtpModal(onSuccessCallback) {
    // 1. Automatically trigger sending the OTP when the modal is invoked
    try {
        await apiFetch('/api/auth/send-otp', { method: 'POST' });
        showNotification('Verification PIN sent to your email.', 'info');
    } catch (error) {
        showNotification(`Failed to send PIN: ${error.message}`, 'error');
        return; // Stop if we couldn't send the OTP
    }

    // 2. Create the modal UI
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 10000;';
    
    const modal = document.createElement('div');
    modal.style.cssText = 'background: white; padding: 25px; border-radius: 8px; max-width: 400px; width: 90%; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.2); font-family: sans-serif;';
    
    modal.innerHTML = `
        <h3 style="margin-top: 0; font-size: 1.5em; color: #333;">Identity Verification</h3>
        <p style="color: #555; margin-bottom: 15px;">For your security, please enter the 6-digit PIN we just sent to your email.</p>
        <input type="text" id="otp-pin-input" placeholder="Enter PIN" maxlength="6" style="width: 100%; padding: 12px; margin-bottom: 20px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; font-size: 1.2em; text-align: center; letter-spacing: 5px;" autocomplete="one-time-code">
        <div style="display: flex; gap: 10px;">
            <button id="cancel-otp-btn" style="flex: 1; padding: 10px; border: none; background: #6c757d; color: white; border-radius: 4px; cursor: pointer; font-weight: bold;">Cancel</button>
            <button id="verify-otp-btn" style="flex: 1; padding: 10px; border: none; background: #007bff; color: white; border-radius: 4px; cursor: pointer; font-weight: bold;">Verify</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = modal.querySelector('#otp-pin-input');
    const cancelBtn = modal.querySelector('#cancel-otp-btn');
    const verifyBtn = modal.querySelector('#verify-otp-btn');

    input.focus();
    const closeModal = () => document.body.removeChild(overlay);
    cancelBtn.addEventListener('click', closeModal);

    verifyBtn.addEventListener('click', async () => {
        const pin = input.value.trim();
        if (!pin || pin.length !== 6) {
            return showNotification('Please enter a valid 6-digit PIN.', 'warning');
        }

        const originalText = verifyBtn.textContent;
        verifyBtn.disabled = true;
        verifyBtn.textContent = 'Verifying...';

        try {
            // 3. Verify the OTP against the backend
            await apiFetch('/api/auth/verify-otp', { method: 'POST', body: { pin } });
            
            showNotification('Identity verified successfully.', 'success');
            closeModal();
            
            // 4. If successful, run the callback to resume the original action
            if (typeof onSuccessCallback === 'function') onSuccessCallback();
        } catch (error) {
            showNotification(`Verification failed: ${error.message}`, 'error');
            verifyBtn.disabled = false;
            verifyBtn.textContent = originalText;
            input.value = ''; // Clear input for retry
            input.focus();
        }
    });
}