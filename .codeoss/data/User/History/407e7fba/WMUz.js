const express = require('express');
const pool = require('../db'); // Adjust path based on your directory structure

const router = express.Router();

/**
 * POST /api/auth/logout
 * Logs out the user by clearing cookies and invalidating the stored refresh token.
 */
router.post('/logout', async (req, res) => {
    // 1. Extract the refresh token from the cookie
    // We use optional chaining in case req.cookies is undefined
    const refreshToken = req.cookies?.refreshToken;

    // 2. Define cookie clearing options
    // These must exactly match the attributes (httpOnly, secure, sameSite) used when setting the cookies!
    const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
    };

    // 3. Always clear the cookies on the client side, even if the DB operation fails later
    res.clearCookie('token', cookieOptions);
    res.clearCookie('refreshToken', cookieOptions);

    // 4. If a refresh token was provided, remove it from the database
    if (refreshToken) {
        try {
            // We query by the token string itself rather than decoding it.
            // This safely handles cases where the token might already be expired but is still in the DB.
            await pool.query(
                'UPDATE users SET refresh_token = NULL WHERE refresh_token = $1',
                [refreshToken]
            );
        } catch (error) {
            console.error('Logout Database Error:', error);
        }
    }

    // 5. Send a success response
    res.status(200).json({ message: 'Logged out successfully.' });
});

module.exports = router;