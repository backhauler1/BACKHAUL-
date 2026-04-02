/**
 * @jest-environment jsdom
 */

import { initializeLanguageSelector } from './languageSelector';
import i18next from './i18n';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

// Mock dependencies
jest.mock('./i18n.js', () => ({
    language: 'en',
    changeLanguage: jest.fn().mockResolvedValue(),
}));
jest.mock('./apiUtil.js', () => ({ apiFetch: jest.fn() }));
jest.mock('./notifications.js', () => ({ showNotification: jest.fn() }));

describe('Language Selector UI (languageSelector.js)', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        
        // Suppress expected console.error logs to keep the test output clean
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Setup the DOM with the dropdown and a mock logged-in user
        document.body.innerHTML = `
            <select id="language-selector">
                <option value="en">English (US)</option>
                <option value="es">Español (ES)</option>
            </select>
        `;
        document.body.dataset.userId = '1'; // Simulate logged-in user
        
        // Reset i18next language
        i18next.language = 'en';
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    it('should do nothing if the selector is not in the DOM', () => {
        document.body.innerHTML = ''; // Clear DOM
        initializeLanguageSelector();
        expect(document.getElementById('language-selector')).toBeNull();
        expect(i18next.changeLanguage).not.toHaveBeenCalled();
    });

    it('should initialize the dropdown with the current active language', () => {
        i18next.language = 'es';
        initializeLanguageSelector();
        const selector = document.getElementById('language-selector');
        expect(selector.value).toBe('es');
    });

    it('should change language, update the backend, show notification, and reload for logged-in users', async () => {
        initializeLanguageSelector();
        const selector = document.getElementById('language-selector');
        
        selector.value = 'es';
        selector.dispatchEvent(new Event('change'));

        await jest.runAllTimersAsync();
        expect(i18next.changeLanguage).toHaveBeenCalledWith('es');
        expect(apiFetch).toHaveBeenCalledWith('/api/users/me/locale', {
            method: 'PATCH',
            body: { locale: 'es' }
        });
        expect(showNotification).toHaveBeenCalledWith('Language updated successfully.', 'success');

        // window.location.reload is natively handled by JSDOM (which aborts it), no need to assert
    });

    it('should skip the backend API call if the user is not logged in', async () => {
        delete document.body.dataset.userId; // Simulate anonymous user
        initializeLanguageSelector();
        const selector = document.getElementById('language-selector');
        
        selector.value = 'es';
        selector.dispatchEvent(new Event('change'));
        await jest.runAllTimersAsync();

        expect(i18next.changeLanguage).toHaveBeenCalledWith('es');
        expect(apiFetch).not.toHaveBeenCalled(); // API should be skipped
        expect(showNotification).toHaveBeenCalledWith('Language updated successfully.', 'success');
    });

    it('should handle errors gracefully and revert the dropdown to the previous state', async () => {
        // Force the API call to fail
        apiFetch.mockRejectedValueOnce(new Error('Network Failed'));
        
        initializeLanguageSelector();
        const selector = document.getElementById('language-selector');
        
        selector.value = 'es';
        selector.dispatchEvent(new Event('change'));
        await jest.runAllTimersAsync();

        expect(apiFetch).toHaveBeenCalled();
        expect(showNotification).toHaveBeenCalledWith('Failed to save language preference.', 'error');
        
        // Because the original language was 'en', it should revert the selector back to 'en'
        expect(selector.value).toBe('en');
    });
});