const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { authLimiter } = require('./rateLimiter');
const sendEmail = require('./email');
const { protect } = require('./auth');
const redisClient = require('./redis');

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

        // Check if the account has been suspended by an admin
        if (user.is_suspended) {
            return res.status(403).json({ message: 'Your account has been suspended. Please contact support.' });
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
            'UPDATE users SET refresh_token = $1, last_login_at = NOW(), deletion_warning_sent = false WHERE id = $2',
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
            user: { id: user.id, email: user.email, roles: user.roles, referralCode: user.referral_code }
        });

    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ message: 'Internal server error during login.' });
    }
});

/**
 * POST /api/auth/forgot-password
 * Sends a password reset link to the user's email.
 */
router.post('/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'Email is required.' });
    }

    try {
        const userQuery = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = userQuery.rows[0];

        if (user) {
            // Use the user's current password hash as part of the secret.
            // This ensures the token is strictly one-time-use: once the password changes, the token is invalid.
            const secret = process.env.JWT_SECRET + user.password;
            
            const token = jwt.sign({ email: user.email, id: user.id }, secret, { expiresIn: '1h' });
            
            // In a real application, the origin should come from environment variables (e.g., process.env.FRONTEND_URL)
            const resetLink = `${req.headers.origin || 'http://localhost:3000'}/reset-password?token=${token}&id=${user.id}`;

            const emailOptions = {
                to: user.email,
                subject: 'Password Reset Request',
                text: `You requested a password reset. Please click the following link to reset your password: ${resetLink}\n\nThis link is valid for 1 hour.`,
                html: `<p>You requested a password reset.</p><p>Please click the link below to reset your password:</p><p><a href="${resetLink}">${resetLink}</a></p><p>This link is valid for 1 hour.</p>`
            };

            await sendEmail(emailOptions);
        }

        // Always return 200 OK to prevent email enumeration attacks
        res.status(200).json({ message: 'If an account exists with that email, a password reset link has been sent.' });
    } catch (error) {
        console.error('Forgot Password Error:', error);
        res.status(500).json({ message: 'Internal server error during password reset request.' });
    }
});

/**
 * POST /api/auth/reset-password
 * Verifies the token and updates the user's password.
 */
router.post('/reset-password', authLimiter, async (req, res) => {
    const { id, token, newPassword } = req.body;

    if (!id || !token || !newPassword) {
        return res.status(400).json({ message: 'ID, token, and new password are required.' });
    }

    if (newPassword.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    try {
        const userQuery = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        const user = userQuery.rows[0];

        if (!user) {
            return res.status(400).json({ message: 'Invalid or expired reset token.' });
        }

        const secret = process.env.JWT_SECRET + user.password;

        try {
            jwt.verify(token, secret);
        } catch (err) {
            return res.status(400).json({ message: 'Invalid or expired reset token.' });
        }

        // Hash the new password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

        // Update the password in the database and immediately clear their refresh_token to log out active sessions
        await pool.query(
            'UPDATE users SET password = $1, refresh_token = NULL WHERE id = $2',
            [hashedPassword, id]
        );

        res.status(200).json({ message: 'Password has been successfully reset. You can now log in with your new password.' });
    } catch (error) {
        console.error('Reset Password Error:', error);
        res.status(500).json({ message: 'Internal server error during password reset.' });
    }
});

/**
 * POST /api/auth/send-otp
 * Generates a 6-digit OTP and sends it to the authenticated user's email.
 */
router.post('/send-otp', protect, authLimiter, async (req, res) => {
    const userId = req.user.id;

    try {
        const userQuery = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]);
        const user = userQuery.rows[0];

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Generate a 6-digit PIN
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Store the PIN in Redis, expiring in 10 minutes (600 seconds)
        await redisClient.setEx(`user:${userId}:otp`, 600, otp);

        const emailOptions = {
            to: user.email,
            subject: 'Your Verification PIN',
            text: `Hi ${user.name},\n\nYour Verification PIN is: ${otp}\n\nThis PIN will expire in 10 minutes.\n\nBest,\nYour App Team`,
            html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Verification PIN</h2><p>Hi ${user.name},</p><p>Your Verification PIN is: <strong>${otp}</strong></p><p>This PIN will expire in 10 minutes.</p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
        };

        await sendEmail(emailOptions);

        res.status(200).json({ message: 'Verification PIN sent to your email.' });
    } catch (error) {
        console.error('Send OTP Error:', error);
        res.status(500).json({ message: 'Internal server error while sending OTP.' });
    }
});

/**
 * POST /api/auth/verify-otp
 * Verifies the OTP provided by the user.
 */
router.post('/verify-otp', protect, authLimiter, async (req, res) => {
    const userId = req.user.id;
    const { pin } = req.body;

    if (!pin) {
        return res.status(400).json({ message: 'PIN is required.' });
    }

    try {
        const storedOtp = await redisClient.get(`user:${userId}:otp`);

        if (!storedOtp) {
            return res.status(400).json({ message: 'PIN has expired or was not requested.' });
        }

        if (storedOtp !== pin.toString()) {
            return res.status(401).json({ message: 'Invalid PIN. Please try again.' });
        }

        // PIN is correct, delete it from Redis so it can't be reused
        await redisClient.del(`user:${userId}:otp`);

        // Set a flag in Redis indicating this user is verified for sensitive actions (e.g., valid for 15 mins)
        await redisClient.setEx(`user:${userId}:verified`, 900, 'true');

        res.status(200).json({ message: 'Identity verified successfully.' });
    } catch (error) {
        console.error('Verify OTP Error:', error);
        res.status(500).json({ message: 'Internal server error while verifying OTP.' });
    }
});

module.exports = router;