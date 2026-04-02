const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

/**
 * POST /api/auth/refresh
 * Verifies the refresh token and issues a new access token.
 */
router.post('/refresh', async (req, res) => {
    // 1. Extract the refresh token from the cookie
    const refreshToken = req.cookies.refreshToken;

    if (!refreshToken) {
        return res.status(401).json({ message: 'Not authorized, no refresh token provided.' });
    }

    try {
        // 2. Verify the refresh token using the dedicated secret
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

        // 3. Ensure the user still exists in the database
        const userQuery = await pool.query('SELECT id FROM users WHERE id = $1', [decoded.id]);
        const user = userQuery.rows[0];

        if (!user) {
            return res.status(401).json({ message: 'User no longer exists.' });
        }

        // 4. Issue a new short-lived Access Token
        const newAccessToken = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: '15m', // Valid for 15 minutes
        });

        // 5. Send the new access token in an httpOnly cookie
        res.cookie('token', newAccessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 15 * 60 * 1000, // 15 minutes
        });

        res.status(200).json({ message: 'Access token refreshed successfully.' });
    } catch (error) {
        console.error('Refresh Token Error:', error);
        return res.status(403).json({ message: 'Refresh token is invalid or has expired. Please log in again.' });
    }
});

module.exports = router;