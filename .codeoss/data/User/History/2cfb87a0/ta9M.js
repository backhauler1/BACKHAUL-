const crypto = require('crypto');

/**
 * Generates a new CSRF token, sets it in an httpOnly cookie,
 * and returns it in the response body so the client can use it.
 */
const generateCsrfToken = (req, res) => {
    // Generate a cryptographically strong random token
    const token = crypto.randomBytes(32).toString('hex');
    
    // Set the token in an httpOnly cookie
    res.cookie('_csrf', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
    });

    // Send the token to the frontend to store in memory
    res.status(200).json({ csrfToken: token });
};

/**
 * Middleware to validate the CSRF token on state-changing requests.
 */
const validateCsrf = (req, res, next) => {
    // Skip CSRF validation for safe HTTP methods and specific server-to-server webhooks
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.originalUrl === '/api/stripe/webhook') {
        return next();
    }

    const cookieToken = req.cookies ? req.cookies._csrf : null;
    const headerToken = req.headers['x-csrf-token'];

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return res.status(403).json({ message: 'CSRF token validation failed. Unauthorized request.' });
    }

    next();
};

module.exports = { generateCsrfToken, validateCsrf };