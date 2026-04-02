/**
 * @jest-environment jsdom
 */

import { initializeReferralDashboard } from './referralDashboard';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

jest.mock('./apiUtil', () => ({ apiFetch: jest.fn() }));
jest.mock('./notifications', () => ({ showNotification: jest.fn() }));

describe('Referral Dashboard UI (referralDashboard.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        document.body.innerHTML = `<div id="referral-container"></div>`;
        
        // Mock the browser's clipboard API
        Object.assign(navigator, {
            clipboard: {
                writeText: jest.fn().mockResolvedValue(),
            },
        });
    });

    it('should fetch, render the referral stats, and handle copying the link', async () => {
        apiFetch.mockResolvedValueOnce({ referralCode: 'REF123', totalReferred: 5 });

        await initializeReferralDashboard('referral-container');

        const container = document.getElementById('referral-container');
        expect(apiFetch).toHaveBeenCalledWith('/api/users/me/referrals');
        expect(container.innerHTML).toContain('REF123');
        expect(container.innerHTML).toContain('5');
        expect(container.innerHTML).toContain('Friends Successfully Referred');

        // Simulate clicking the "Copy Link" button
        const copyBtn = document.getElementById('copy-referral-btn');
        await copyBtn.click();

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('register?referralCode=REF123'));
        expect(showNotification).toHaveBeenCalledWith('Referral link copied to clipboard!', 'success');
    });

    it('should show an error message if the API call fails', async () => {
        apiFetch.mockRejectedValueOnce(new Error('Network error'));
        jest.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console.error in tests

        await initializeReferralDashboard('referral-container');

        const container = document.getElementById('referral-container');
        expect(container.innerHTML).toContain('Failed to load referral statistics');
    });
});