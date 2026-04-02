import i18next from 'i18next';
import HttpBackend from 'i18next-http-backend';

// Initialize i18next
export const initPromise = i18next
    .use(HttpBackend)
    .init({
        // Automatically detect the browser's language, fallback to English
        lng: navigator.language || 'en', 
        fallbackLng: 'en',
        backend: {
            // Path where your frontend server hosts the translation files
            loadPath: '/locales/{{lng}}/{{ns}}.json' 
        }
    });

// Export the translation function 't' to use across your app
export const t = i18next.t.bind(i18next);
export default i18next;