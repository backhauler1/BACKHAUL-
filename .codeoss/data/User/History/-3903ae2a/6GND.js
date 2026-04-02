const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('./db');
const sendEmail = require('./email');
const { authLimiter } = require('./middleware/rateLimiter');
const { protect } = require('./auth');

const router = express.Router();

/**
 * POST /api/auth/forgot-password
 * Generates a reset token and sends an email to the user.
 */
router.post('/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'Please provide an email address.' });
    }

    try {
        // 1. Check if the user exists
        const userQuery = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);
        const user = userQuery.rows[0];

        if (!user) {
            // We return 200 even if the user doesn't exist to prevent "Email Enumeration" attacks
            // (where an attacker uses your form to check if an email is registered).
            return res.status(200).json({ message: 'If an account with that email exists, we have sent a password reset link.' });
        }

        // 2. Generate a secure random reset token
        const resetToken = crypto.randomBytes(32).toString('hex');

        // 3. Hash the token before saving it to the database for security (in case the DB is compromised)
        const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

        // 4. Set expiration time (e.g., 1 hour from now)
        const expiresIn = new Date(Date.now() + 60 * 60 * 1000);

        // 5. Save the hashed token and expiration to the database
        await pool.query(
            `UPDATE users 
             SET reset_password_token = $1, reset_password_expires = $2 
             WHERE id = $3`,
            [hashedToken, expiresIn, user.id]
        );

        // 6. Create the reset URL
        // Ensure you set FRONTEND_URL in your .env file to direct users to your site
        const frontendUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
        const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;

        // 7. Send the email
        const emailOptions = {
            to: email,
            subject: 'Password Reset Request',
            text: `Hi ${user.name},\n\nYou requested a password reset. Please go to this link to reset your password:\n\n${resetUrl}\n\nThis link will expire in 1 hour.\nIf you did not request this, please ignore this email.`,
            html: `
                <div style="font-family: sans-serif; line-height: 1.6;">
                    <h2>Password Reset</h2>
                    <p>Hi ${user.name},</p>
                    <p>You requested a password reset. Click the button below to choose a new password:</p>
                    <a href="${resetUrl}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">Reset Password</a>
                    <p>Or copy and paste this link into your browser:</p>
                    <p><a href="${resetUrl}">${resetUrl}</a></p>
                    <p>This link will expire in 1 hour. If you did not request this, please ignore this email.</p>
                </div>
            `
        };

        await sendEmail(emailOptions);

        res.status(200).json({ message: 'If an account with that email exists, we have sent a password reset link.' });

    } catch (error) {
        console.error('Forgot Password Error:', error);
        res.status(500).json({ message: 'There was an error processing your request.' });
    }
});

/**
 * POST /api/auth/reset-password
 * Verifies the token and updates the user's password.
 */
router.post('/reset-password', authLimiter, async (req, res) => {
    const { token, email, newPassword } = req.body;

    if (!token || !email || !newPassword) {
        return res.status(400).json({ message: 'Token, email, and new password are required.' });
    }

    if (newPassword.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    try {
        // 1. Hash the provided token to compare with the hashed one in the database
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        // 2. Find the user by email, token, and ensure the token hasn't expired
        const userQuery = await pool.query(
            `SELECT id, name FROM users 
             WHERE email = $1 
               AND reset_password_token = $2 
               AND reset_password_expires > NOW()`,
            [email, hashedToken]
        );

        const user = userQuery.rows[0];

        if (!user) {
            return res.status(400).json({ message: 'Invalid or expired password reset token.' });
        }

        // 3. Hash the new password and clear the reset token fields
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

        await pool.query(
            `UPDATE users 
             SET password = $1, reset_password_token = NULL, reset_password_expires = NULL, refresh_token = NULL, token_version = COALESCE(token_version, 0) + 1 
             WHERE id = $2`,
            [hashedPassword, user.id]
        );

        // 4. Send a security notification email
        try {
            const emailOptions = {
                to: email,
                subject: 'Your Password Has Been Changed',
                text: `Hi ${user.name},\n\nThis is a confirmation that the password for your account has just been changed.\n\nIf you did not authorize this change, please reset your password immediately and contact our support team.\n\nBest,\nYour App Team`,
                html: `
                    <div style="font-family: sans-serif; line-height: 1.6;">
                        <h2>Security Alert: Password Changed</h2>
                        <p>Hi ${user.name},</p>
                        <p>This is a confirmation that the password for your account has just been changed.</p>
                        <p>If you made this change, you can safely disregard this email.</p>
                        <p><strong>If you did not authorize this change, please reset your password immediately and contact our support team.</strong></p>
                        <br>
                        <p>Best,</p>
                        <p><strong>Your App Team</strong></p>
                    </div>
                `
            };
            await sendEmail(emailOptions);
        } catch (emailError) {
            console.error('Failed to send password change notification email after reset:', emailError);
        }

        res.status(200).json({ message: 'Password has been successfully reset. You can now log in.' });

    } catch (error) {
        console.error('Reset Password Error:', error);
        res.status(500).json({ message: 'Internal server error during password reset.' });
    }
});

/**
 * POST /api/auth/change-password
 * Changes the password for a logged-in user.
 */
router.post('/change-password', protect, authLimiter, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id; // Extracted from the `protect` middleware

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Current and new passwords are required.' });
    }

    if (newPassword.length < 8) {
        return res.status(400).json({ message: 'New password must be at least 8 characters long.' });
    }

    try {
        // Fetch the user's current password hash
        const userQuery = await pool.query('SELECT password, name, email FROM users WHERE id = $1', [userId]);
        const user = userQuery.rows[0];

        // Verify the current password
        if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
            return res.status(401).json({ message: 'Incorrect current password.' });
        }

        // Hash the new password and update it in the database
        const saltRounds = 10;
        const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);
        await pool.query('UPDATE users SET password = $1, refresh_token = NULL, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2', [hashedNewPassword, userId]);

        // Send a security notification email
        try {
            const emailOptions = {
                to: user.email,
                subject: 'Your Password Has Been Changed',
                text: `Hi ${user.name},\n\nThis is a confirmation that the password for your account has just been changed.\n\nIf you did not make this change, please contact our support team immediately.\n\nBest,\nYour App Team`,
                html: `
                    <div style="font-family: sans-serif; line-height: 1.6;">
                        <h2>Security Alert: Password Changed</h2>
                        <p>Hi ${user.name},</p>
                        <p>This is a confirmation that the password for your account has just been changed from your account settings.</p>
                        <p>If you made this change, you can safely disregard this email.</p>
                        <p><strong>If you did not authorize this change, please contact our support team immediately.</strong></p>
                        <br>
                        <p>Best,</p>
                        <p><strong>Your App Team</strong></p>
                    </div>
                `
            };
            await sendEmail(emailOptions);
        } catch (emailError) {
            console.error('Failed to send password change notification email:', emailError);
        }

        // Clear the cookies on the current device to terminate the active session locally
        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
        };
        res.clearCookie('token', cookieOptions);
        res.clearCookie('refreshToken', cookieOptions);

        res.status(200).json({ message: 'Password has been successfully updated. Please log in again.' });
    } catch (error) {
        console.error('Change Password Error:', error);
        res.status(500).json({ message: 'Internal server error while changing password.' });
    }
});

module.exports = router;