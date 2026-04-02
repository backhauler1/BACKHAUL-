const jwt = require('jsonwebtoken');
const pool = require('./db');
const redisClient = require('./redis'); // Import the Redis client

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
        
        // 2. Check the token version using Redis Cache to speed up requests.
        const cacheKey = `user:${decoded.id}:token_version`;
        let tokenVersion;
        
        try {
            const cachedVersion = await redisClient.get(cacheKey);
            if (cachedVersion !== null) {
                tokenVersion = parseInt(cachedVersion, 10);
            }
        } catch (redisErr) {
            console.error('Redis GET error:', redisErr);
        }

        // Cache miss or Redis failure: Query the database
        if (tokenVersion === undefined) {
            const userQuery = await pool.query('SELECT token_version FROM users WHERE id = $1', [decoded.id]);
            const user = userQuery.rows[0];

            if (!user) {
                return res.status(401).json({ message: 'Session invalidated. Please log in again.' });
            }
            tokenVersion = user.token_version || 0;
            
            try {
                await redisClient.setEx(cacheKey, 3600, tokenVersion.toString()); // Cache for 1 hour
            } catch (redisErr) {
                console.error('Redis SET error:', redisErr);
            }
        }

        if (tokenVersion !== (decoded.tokenVersion || 0)) {
            return res.status(401).json({ message: 'Session invalidated. Please log in again.' });
        }

        // 3. Attach user information from the token payload to the request object.
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