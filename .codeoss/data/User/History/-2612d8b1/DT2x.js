const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db'); // Assuming this is in a 'routes' directory

const router = express.Router();

/**
 * POST /api/auth/refresh
 * Verifies a refresh token and issues a new access token.
 */
router.post('/refresh', async (req, res) => {
    // 1. Get the refresh token from the httpOnly cookie
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
        return res.status(401).json({ message: 'Refresh token not found.' });
    }

    try {
        // 2. Find the user in the database who owns this refresh token
        const userQuery = await pool.query(
            'SELECT * FROM users WHERE refresh_token = $1',
            [refreshToken]
        );
        const user = userQuery.rows[0];

        // If no user is found, the token is invalid or has been revoked (e.g., by logout)
        if (!user) {
            return res.status(403).json({ message: 'Invalid refresh token.' });
        }

        // 3. Verify the refresh token's signature and expiration
        jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, (err, decoded) => {
            if (err || decoded.id !== user.id) {
                // This catches expired tokens, malformed tokens, or a token-user mismatch.
                return res.status(403).json({ message: 'Refresh token is not valid.' });
            }

            // 4. Generate a new short-lived Access Token
            const newAccessToken = jwt.sign({ id: user.id, roles: user.roles, tokenVersion: user.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '15m' });

            // 5. Set the new access token in a secure cookie
            res.cookie('token', newAccessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 15 * 60 * 1000 });

            // 6. Send success response
            res.status(200).json({ message: 'Access token refreshed successfully.' });
        });
    } catch (error) {
        console.error('Refresh Token Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

module.exports = router;