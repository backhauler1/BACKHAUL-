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
    overlay.className = 'otp-overlay';
    
    const modal = document.createElement('div');
    modal.className = 'otp-modal';
    
    modal.innerHTML = `
        <h3>Identity Verification</h3>
        <p>For your security, please enter the 6-digit PIN we just sent to your email.</p>
        <input type="text" id="otp-pin-input" placeholder="Enter PIN" maxlength="6" autocomplete="one-time-code">
        <div class="button-container">
            <button id="cancel-otp-btn" class="btn btn-cancel">Cancel</button>
            <button id="verify-otp-btn" class="btn">Verify</button>
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