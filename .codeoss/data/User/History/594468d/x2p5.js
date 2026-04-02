import i18next from './i18n.js';
import { apiFetch } from './apiUtil.js';
import { showNotification } from './notifications.js';

export function initializeLanguageSelector() {
    const selector = document.getElementById('language-selector');
    if (!selector) return;

    // Set the initial value of the dropdown to match the currently active language
    selector.value = i18next.language || 'en';

    selector.addEventListener('change', async (e) => {
        const newLocale = e.target.value;

        try {
            // 1. Instantly change the language in the frontend UI
            await i18next.changeLanguage(newLocale);
            
            // 2. Save the preference to the backend (for cron emails, etc.)
            // We only attempt this if the user is currently logged in.
            const userId = document.body.dataset.userId;
            if (userId) {
                await apiFetch('/api/users/me/locale', {
                    method: 'PATCH',
                    body: { locale: newLocale }
                });
            }
            
            showNotification(`Language updated successfully.`, 'success');
            
            // Force a page reload to ensure all hardcoded components instantly re-render 
            // with the new translation keys applied.
            setTimeout(() => window.location.reload(), 1000);

        } catch (error) {
            console.error('Failed to update language:', error);
            showNotification('Failed to save language preference.', 'error');
            // Revert dropdown to previous state if the API call failed
            selector.value = i18next.language;
        }
    });
}