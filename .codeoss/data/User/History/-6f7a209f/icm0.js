const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');

// Load environment variables
require('dotenv').config();

// Import your routes
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
const { startCronJobs } = require('./cron');
// ... import other routers

const app = express();

// --- Stripe Webhook Middleware ---
// This route must be defined before `express.json()` because Stripe requires the raw request body for signature verification.
// The `stripeRouter` will then handle the logic for the '/webhook' path.
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// --- Global Middleware ---
app.use(express.json());
app.use(cookieParser());

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
}));

// --- CORS Configuration ---
const corsOptions = {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000', // Restrict this to your actual frontend domain(s)
    credentials: true, // Required to allow cookies (JWT, CSRF) to be sent across origins
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], // Strictly allow only these methods
    allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token'], // Whitelist your custom headers
};
app.use(cors(corsOptions));

// --- Security Routes ---
app.get('/api/csrf-token', generateCsrfToken);

// Globally enforce CSRF validation for all following routes
app.use(validateCsrf);

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
// ... use other routers

// --- Server Activation ---
// Only listen for connections if the file is run directly (not imported as a module for testing)
if (process.env.NODE_ENV !== 'test') {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        startCronJobs(); // Initialize background tasks
    });
}

// Export the app for testing purposes
module.exports = app;