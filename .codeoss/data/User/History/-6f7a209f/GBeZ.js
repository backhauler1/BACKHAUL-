const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');

// Integrations
const Sentry = require('@sentry/node');
const logger = require('./logger');

// Load environment variables
require('dotenv').config();

// Import your routes
const pool = require('./db');
const { initializeSocketHandlers } = require('./socketHandlers');
const { generateCsrfToken, validateCsrf } = require('./csrf');
const loginRouter = require('./login');
const refreshRouter = require('./refresh');
const registerRouter = require('./register');
const logoutRouter = require('./logout');
const passwordResetRouter = require('./passwordReset');
const companiesRouter = require('./companies');
const loadsRouter = require('./loads');
const trucksRouter = require('./trucks');
const stripeRouter = require('./stripe');
const orderRoutes = require('./orderRoutes');
const usersRouter = require('./users');
const { apiLimiter } = require('./rateLimiter');
const { startCronJobs } = require('./cron');
const { i18next, middleware } = require('./i18nBackend');
// ... import other routers

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');

// --- Sentry Initialization ---
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        tracesSampleRate: 1.0, // Capture 100% of transactions (adjust down in production)
    });
    app.use(Sentry.Handlers.requestHandler());
}

// --- Trust Proxy & Force HTTPS ---
// Required for reverse proxies (like Heroku or AWS) to correctly pass protocol headers
app.set('trust proxy', 1);

if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        if (req.headers['x-forwarded-proto'] !== 'https') {
            return res.redirect(301, `https://${req.headers.host}${req.url}`);
        }
        next();
    });
}

// --- Stripe Webhook Middleware ---
// This route must be defined before `express.json()` because Stripe requires the raw request body for signature verification.
// The `stripeRouter` will then handle the logic for the '/webhook' path.
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// --- Global Middleware ---
app.use(express.json());
app.use(cookieParser());

// --- i18n Translation Middleware ---
app.use(middleware.handle(i18next));

// --- Security Headers (Helmet) ---
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            "default-src": ["'self'"],
            // Whitelist Stripe and Mapbox scripts
            "script-src": ["'self'", "https://js.stripe.com", "https://api.mapbox.com"],
            "frame-src": ["'self'", "https://js.stripe.com"], // Stripe Elements uses iframes
            "connect-src": ["'self'", "https://api.stripe.com", "https://api.mapbox.com", "https://events.mapbox.com"],
            "img-src": ["'self'", "data:", "blob:", "https://via.placeholder.com", "https://cdn-icons-png.flaticon.com"],
            "worker-src": ["'self'", "blob:"], // Mapbox heavily relies on web workers via blob URIs
        },
    },
    xssFilter: true, // Explicitly enforce the X-XSS-Protection header
    noSniff: true,   // Explicitly enforce the X-Content-Type-Options: nosniff header
    hsts: {
        maxAge: 31536000, // Enforce HTTPS for 1 year (in seconds)
        includeSubDomains: true, // Apply rule to all subdomains
        preload: true, // Allows you to submit your site to the browser HSTS preload list
    },
}));

// --- CORS Configuration ---
const corsOptions = {
    origin: process.env.FRONTEND_URL || [
        'https://gottabackhaul.com', 
        'http://localhost:3000'
    ], // Restrict this to your actual frontend domain(s)
    credentials: true, // Required to allow cookies (JWT, CSRF) to be sent across origins
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], // Strictly allow only these methods
    allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token'], // Whitelist your custom headers
};
app.use(cors(corsOptions));

// --- Global Rate Limiting ---
// Apply the general API rate limiter to all routes starting with /api
app.use('/api', apiLimiter);

// --- Security Routes ---
app.get('/api/csrf-token', generateCsrfToken);

// Globally enforce CSRF validation for all following routes
// We skip the webhook route because Stripe cannot provide a CSRF token
app.use((req, res, next) => {
    if (req.originalUrl === '/api/stripe/webhook') {
        return next();
    }
    validateCsrf(req, res, next);
});

// --- Routes ---
app.use('/api/auth', loginRouter);
app.use('/api/auth', refreshRouter);
app.use('/api/auth', registerRouter);
app.use('/api/auth', logoutRouter);
app.use('/api/auth', passwordResetRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/loads', loadsRouter);
app.use('/api/trucks', trucksRouter);
app.use('/api/stripe', stripeRouter);
app.use('/api/orders', orderRoutes);
app.use('/api/users', usersRouter);
// ... use other routers

// --- Sentry Error Handler ---
if (process.env.SENTRY_DSN) {
    app.use(Sentry.Handlers.errorHandler());
}

// --- Socket.IO WebSockets Setup ---
const io = new Server(server, {
    cors: corsOptions
});

// Initialize all Socket.IO event handlers from the dedicated module
initializeSocketHandlers(io);

// --- Server Activation ---
// Only listen for connections if the file is run directly (not imported as a module for testing)
if (process.env.NODE_ENV !== 'test') {
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
        logger.info(`Server running on port ${PORT}`);
        startCronJobs(); // Initialize background tasks
    });
}

// Export the app for testing purposes
module.exports = app;