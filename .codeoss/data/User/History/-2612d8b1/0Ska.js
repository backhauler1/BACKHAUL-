const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

/**
 * POST /api/auth/refresh
 * Verifies the refresh token and issues a new access token.
 */
router.post('/refresh', authLimiter, async (req, res) => {
    // 1. Extract the refresh token from the httpOnly cookie
    const refreshToken = req.cookies.refreshToken;

    if (!refreshToken) {
        return res.status(401).json({ message: 'Authorization failed: No refresh token provided.' });
    }

    try {
        // 2. Verify the refresh token using the dedicated secret
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

        // 3. Ensure the user still exists and fetch their roles for the new token.
        // This assumes your 'users' table has a 'roles' column (e.g., TEXT[] in PostgreSQL)
        // which is necessary for middleware like `authorize('admin')` to work efficiently.
        const userQuery = await pool.query('SELECT id, roles FROM users WHERE id = $1', [decoded.id]);
        const user = userQuery.rows[0];

        if (!user) {
            // If user is not found, the token is for a deleted user.
            // Clear the cookies to prevent the client from sending them again.
            res.clearCookie('token', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
            res.clearCookie('refreshToken', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
            return res.status(401).json({ message: 'User associated with this token no longer exists.' });
        }

        // 4. Issue a new short-lived Access Token, including user roles.
        // Including roles in the payload allows authorization middleware to check permissions
        // without needing an extra database query on every protected request.
        const newAccessToken = jwt.sign({ id: user.id, roles: user.roles }, process.env.JWT_SECRET, {
            expiresIn: '15m', // Keep access tokens short-lived
        });

        // 5. Send the new access token in a secure, httpOnly cookie
        res.cookie('token', newAccessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 15 * 60 * 1000, // 15 minutes, matching token expiry
        });

        res.status(200).json({ message: 'Access token refreshed successfully.' });
    } catch (error) {
        // If the token is invalid for any reason (expired, malformed), clear the cookies.
        res.clearCookie('token', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
        res.clearCookie('refreshToken', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });

        if (error instanceof jwt.TokenExpiredError) {
            // It's useful to log when an expired token is used, but as a warning, not an error.
            // We can try to get the user ID from the expired token's payload for logging.
            const expiredPayload = jwt.decode(refreshToken);
            console.warn(`Expired refresh token used for user ID: ${expiredPayload?.id || 'unknown'}.`);
            return res.status(403).json({ message: 'Refresh token has expired. Please log in again.' });
        }
        
        console.error('Refresh Token Verification Error:', error.name, error.message);
        return res.status(403).json({ message: 'Refresh token is invalid. Please log in again.' });
    }
});

module.exports = router;