const jwt = require('jsonwebtoken');
const pool = require('../db');

/**
 * Middleware to protect routes that require authentication.
 * It verifies a JWT from cookies and attaches the user to the request object.
 */
const protect = async (req, res, next) => {
    let token;

    if (req.cookies && req.cookies.token) {
        token = req.cookies.token;
    }

    if (!token) {
        return res.status(401).json({ message: 'Not authorized, no token provided.' });
    }

    try {
        // 1. Verify the token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // 2. Find the user and include the password_changed_at field
        const userQuery = await pool.query(
            'SELECT id, name, email, created_at, password_changed_at, role FROM users WHERE id = $1',
            [decoded.id]
        );
        const currentUser = userQuery.rows[0];

        if (!currentUser) {
            return res.status(401).json({ message: 'Not authorized, user not found.' });
        }

        // 3. Check if token was issued before the last password change
        if (currentUser.password_changed_at) {
            const tokenIssuedAt = new Date(decoded.iat * 1000);
            if (tokenIssuedAt < currentUser.password_changed_at) {
                return res.status(401).json({ message: 'Not authorized, password has been changed recently. Please log in again.' });
            }
        }

        req.user = currentUser;
        
        // 2. Attach user information from the token payload to the request object.
        // The payload now contains the user's ID and roles, so we don't need
        // to query the database on every protected request. This is more performant.
        // The check for user existence is now handled by the refresh token logic.
        // If a user is deleted, their refresh token will fail, and they won't get new access tokens.
        req.user = {
            id: decoded.id,
            roles: decoded.roles || [] // Ensure roles is always an array
        };
        
        next();
    } catch (error) {
        // This will catch expired tokens, malformed tokens, etc.
        return res.status(401).json({ message: 'Not authorized, token failed.' });
    }
};

/**
 * Middleware to restrict access to specific roles.
 * Must be placed AFTER the `protect` middleware in the route definition.
 * @param {...string} roles - The roles allowed to access the route (e.g., 'admin', 'moderator').
 */
const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
        // The `protect` middleware now attaches `req.user` with a `roles` array.
        // We check if the user's roles array has at least one of the required roles.
        const hasRequiredRole = req.user && req.user.roles && req.user.roles.some(userRole => roles.includes(userRole));

        if (!hasRequiredRole) {
            return res.status(403).json({ message: 'Forbidden. You do not have permission to perform this action.' });
        }
        next();
    };
};

module.exports = { protect, authorize };