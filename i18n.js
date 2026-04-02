import i18next from 'i18next';
import ChainedBackend from 'i18next-chained-backend';
import LocalStorageBackend from 'i18next-localstorage-backend';
import HttpBackend from 'i18next-http-backend';

// Automatically use the app version injected by your build process,
// falling back to a default value if it's not set.
const APP_VERSION = process.env.APP_VERSION || 'v1.1.0';

// Initialize i18next
export const initPromise = i18next
    .use(ChainedBackend)
    .init({
        // Automatically detect the browser's language, fallback to English
        lng: navigator.language || 'en', 
        fallbackLng: 'en',
        backend: {
            backends: [
                LocalStorageBackend, // Primary: local storage
                HttpBackend          // Fallback: network
            ],
            backendOptions: [
                {
                    expirationTime: 7 * 24 * 60 * 60 * 1000, // 7 days
                    defaultVersion: APP_VERSION // Busts local storage cache when changed
                },
                {
                    // Appending the version busts browser/CDN HTTP caches
                    loadPath: `/locales/{{lng}}/{{ns}}.json?v=${APP_VERSION}` 
                }
            ]
        }
    });

// Export the translation function 't' to use across your app
export const t = i18next.t.bind(i18next);
export default i18next;