const i18next = require('i18next');
const middleware = require('i18next-http-middleware');
const Backend = require('i18next-fs-backend');
const path = require('path');

i18next
    .use(Backend)
    .use(middleware.LanguageDetector)
    .init({
        fallbackLng: 'en',
        preload: ['en', 'es'],
        backend: {
            // Tells i18next to load JSON files from a "locales" folder based on the current language
            loadPath: path.join(__dirname, 'locales/{{lng}}/{{ns}}.json')
        }
    });

module.exports = { i18next, middleware };