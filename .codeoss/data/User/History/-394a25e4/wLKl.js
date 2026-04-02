const jwt = require('jsonwebtoken');
const pool = require('../db'); // Assumes db.js is in the parent directory

/**
 * Middleware to protect routes that require authentication.
 * It verifies a JWT from cookies and attaches the user to the request object.
 */
const protect = async (req, res, next) => {
    let token;

    // 1. Read the token from the httpOnly cookie
    if (req.cookies && req.cookies.token) {
        token = req.cookies.token;
    }

    if (!token) {
        return res.status(401).json({ message: 'Not authorized, no token provided.' });
    }

    try {
        // 2. Verify the token using the secret from your .env file
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // 3. Find the user in the database by the ID from the token
        // We select all columns except the password for security.
        const userQuery = await pool.query(
            'SELECT id, name, email, created_at FROM users WHERE id = $1',
            [decoded.id]
        );

        const currentUser = userQuery.rows[0];

        if (!currentUser) {
            return res.status(401).json({ message: 'Not authorized, user not found.' });
        }

        // 4. Attach the user object to the request for use in subsequent handlers
        req.user = currentUser;

        next(); // Proceed to the next middleware/route handler
    } catch (error) {
        console.error('Authentication Error:', error);
        return res.status(401).json({ message: 'Not authorized, token failed.' });
    }
};

module.exports = { protect };