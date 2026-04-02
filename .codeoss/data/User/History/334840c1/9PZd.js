const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { authLimiter } = require('./rateLimiter');

const router = express.Router();

/**
 * POST /api/auth/login
 * Authenticates a user, generates tokens, and saves the refresh token to the database.
 */
router.post('/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    try {
        // 1. Find the user in the database
        const userQuery = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = userQuery.rows[0];

        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        // 2. Verify the password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        // 3. Generate a short-lived Access Token (e.g., 15 minutes)
        const accessToken = jwt.sign(
            { id: user.id, roles: user.roles, tokenVersion: user.token_version || 0 }, 
            process.env.JWT_SECRET, 
            { expiresIn: '15m' }
        );

        // 4. Generate a long-lived Refresh Token (e.g., 7 days)
        const refreshToken = jwt.sign(
            { id: user.id }, 
            process.env.JWT_REFRESH_SECRET, 
            { expiresIn: '7d' }
        );

        // 5. CRITICAL STEP: Save the refresh token to the database for this user.
        // This establishes the initial token that the /refresh route will check against.
        await pool.query(
            'UPDATE users SET refresh_token = $1 WHERE id = $2',
            [refreshToken, user.id]
        );

        // 6. Define secure cookie options
        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
        };

        // 7. Send the tokens in httpOnly cookies
        res.cookie('token', accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 }); // 15 mins
        res.cookie('refreshToken', refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 }); // 7 days

        // 8. Send a success response (do not send tokens in the JSON body)
        res.status(200).json({
            message: 'Logged in successfully.',
            user: { id: user.id, email: user.email, roles: user.roles }
        });

    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ message: 'Internal server error during login.' });
    }
});

module.exports = router;