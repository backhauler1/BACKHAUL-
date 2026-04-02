// Load environment variables from .env file.
// It's good practice to have this at the very top.
require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer'); // For handling multer errors

// Import Rate Limiter
const { apiLimiter } = require('./rateLimiter');

// Import Routers
const registerRouter = require('./register');
const passwordResetRouter = require('./passwordReset');
const refreshRouter = require('./refresh');
const companiesRouter = require('./companies');
const orderRoutes = require('./orderRoutes');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // socket.io options can be configured here
});
const port = process.env.PORT || 3000;

// --- Global Middleware ---
// The order of middleware is important.

// Use compression middleware to gzip responses for better performance.
app.use(compression());

// Use morgan for HTTP request logging. The 'dev' format is great for development.
// For production, you might want 'combined'.
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Middleware to parse JSON bodies.
app.use(express.json());

// Middleware to parse URL-encoded bodies.
app.use(express.urlencoded({ extended: true }));

// Middleware to parse cookies, needed for authentication tokens.
app.use(cookieParser());

// Serve static files from the 'dist' directory. This is where your frontend build will go.
// The build.js script outputs to 'dist'.
app.use(express.static(path.join(__dirname, 'dist')));

// --- API Routes ---
// Apply a general rate limiter to all API routes to prevent abuse.
app.use('/api', apiLimiter);

// Mount the various routers on their respective paths.
app.use('/api/auth', registerRouter);
app.use('/api/auth', passwordResetRouter);
app.use('/api/auth', refreshRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/orders', orderRoutes);

// --- Frontend Catch-all Route ---
// For a Single Page Application (SPA), this route is crucial.
// It serves the main HTML file for any request that doesn't match an API route.
// This must come AFTER all your API routes.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- Centralized Error Handling Middleware ---
// This should be the last piece of middleware.
app.use((err, req, res, next) => {
    // Handle Multer-specific errors for file uploads
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ message: 'File is too large.' });
        }
        return res.status(400).json({ message: err.message });
    }
    
    // Log the error for debugging purposes
    console.error(err.stack);

    // Default to a 500 server error response
    res.status(err.status || 500).json({
        message: err.message || 'Internal Server Error'
    });
});

httpServer.listen(port, () => {
  console.log(`Server with socket.io listening on http://localhost:${port}`);
});