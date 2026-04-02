import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

/**
 * Initializes the referral dashboard component, fetching stats and rendering the UI.
 * @param {string} containerId - The ID of the DOM element to render the component into.
 */
export async function initializeReferralDashboard(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Show initial loading state
    container.innerHTML = '<p style="color: #666;">Loading your referral stats...</p>';

    try {
        // Fetch the user's unique referral code and successful referral count
        const data = await apiFetch('/api/users/me/referrals');
        const { referralCode, totalReferred } = data;

        // Construct the full registration URL
        const referralUrl = `${window.location.origin}/register?referralCode=${referralCode}`;

        // Render the UI
        container.innerHTML = `
            <div class="referral-card" style="padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px; background-color: #f9f9fc;">
                <h3 style="margin-top: 0; color: #333;">🎁 Invite & Earn!</h3>
                <p style="color: #555;">Share this link with a friend. When they complete their first load, you both get a reward!</p>
                
                <div style="display: flex; gap: 10px; margin-top: 15px; margin-bottom: 20px;">
                    <input 
                        type="text" 
                        id="referral-link-input" 
                        value="${referralUrl}"
                        readonly 
                        style="flex-grow: 1; padding: 10px; border: 1px solid #ccc; border-radius: 4px; background-color: #fff; color: #333;"
                    >
                    <button 
                        id="copy-referral-btn" 
                        style="padding: 10px 20px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; transition: background-color 0.2s;"
                    >
                        Copy Link
                    </button>
                </div>

                <div style="display: inline-block; padding: 10px 15px; background-color: #e8f4f8; border-left: 4px solid #007bff; border-radius: 4px;">
                    <strong style="color: #007bff; font-size: 1.1em;">${totalReferred}</strong> 
                    <span style="color: #333;">Friends Successfully Referred</span>
                </div>
            </div>
        `;

        // Wire up the copy button using the modern Clipboard API
        const copyBtn = document.getElementById('copy-referral-btn');
        const inputEl = document.getElementById('referral-link-input');

        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(inputEl.value);
                showNotification('Referral link copied to clipboard!', 'success');
                
                // Provide brief visual feedback on the button itself
                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                copyBtn.style.backgroundColor = '#28a745'; // Switch to green
                
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                    copyBtn.style.backgroundColor = '#007bff'; // Switch back to blue
                }, 2000);
            } catch (err) {
                console.error('Failed to copy text: ', err);
                
                // Fallback for older browsers
                inputEl.select();
                document.execCommand('copy');
                showNotification('Referral link copied to clipboard!', 'success');
            }
        });

    } catch (error) {
        console.error('Failed to load referral stats:', error);
        container.innerHTML = '<p style="color: #dc3545;">Failed to load referral statistics. Please try again later.</p>';
    }
}