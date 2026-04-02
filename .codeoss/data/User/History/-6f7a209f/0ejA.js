const express = require('express');
const cookieParser = require('cookie-parser');

// Load environment variables
require('dotenv').config();

// Import your routes
const { generateCsrfToken } = require('./csrf');
const loginRouter = require('./login');
const refreshRouter = require('./refresh');
const registerRouter = require('./register');
const logoutRouter = require('./logout');
const companiesRouter = require('./companies');
const loadsRouter = require('./loads');
// ... import other routers

const app = express();

// --- Global Middleware ---
app.use(express.json());
app.use(cookieParser());

// --- Security Routes ---
app.get('/api/csrf-token', generateCsrfToken);

// --- Routes ---
app.use('/api/auth', loginRouter);
app.use('/api/auth', refreshRouter);
app.use('/api/auth', registerRouter);
app.use('/api/auth', logoutRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/loads', loadsRouter);
// ... use other routers

// --- Server Activation ---
// Only listen for connections if the file is run directly (not imported as a module for testing)
if (process.env.NODE_ENV !== 'test') {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Export the app for testing purposes
module.exports = app;