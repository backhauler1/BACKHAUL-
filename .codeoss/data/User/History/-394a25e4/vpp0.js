const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db'); // Adjust path depending on your folder structure
const sendEmail = require('../utils/email'); // Import the email utility
const { protect } = require('../middleware/auth'); // Import auth protection middleware

const router = express.Router();

/**
 * POST /api/auth/register
 * Registers a new user, hashes their password, and sets an auth cookie.
 */
router.post('/register', async (req, res) => {
    const { name, email, password } = req.body;

    // 1. Enhanced Input Validation
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Please provide name, email, and password.' });
    }

    // Email format validation using a regular expression
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ message: 'Please provide a valid email address.' });
    }

    // Strong password validation rules. We collect all errors to provide better feedback.
    const passwordErrors = [];
    if (password.length < 8) {
        passwordErrors.push('be at least 8 characters long');
    }
    if (!/[A-Z]/.test(password)) {
        passwordErrors.push('contain at least one uppercase letter');
    }
    if (!/[a-z]/.test(password)) {
        passwordErrors.push('contain at least one lowercase letter');
    }
    if (!/[0-9]/.test(password)) {
        passwordErrors.push('contain at least one number');
    }
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
        passwordErrors.push('contain at least one special character');
    }

    if (passwordErrors.length > 0) {
        return res.status(400).json({ message: `Password must ${passwordErrors.join(', ')}.` });
    }

    try {
        // 2. Check if a user with this email already exists
        const userExistsQuery = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (userExistsQuery.rows.length > 0) {
            return res.status(400).json({ message: 'A user with this email already exists.' });
        }

        // 3. Hash the password
        // A "salt" is random data added to the password before hashing to defend against dictionary attacks.
        // '10' is the salt round (cost factor) - a good balance of security and performance.
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        // 4. Insert the new user into the database
        // We use RETURNING to get the newly created user's data (excluding the password)
        const newUserQuery = await pool.query(
            'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
            [name, email, password_hash]
        );

        const newUser = newUserQuery.rows[0];

        // 5. Generate a JWT token so the user is immediately logged in
        const token = jwt.sign({ id: newUser.id }, process.env.JWT_SECRET, {
            expiresIn: '30d',
        });

        // 6. Send the token in a secure, httpOnly cookie
        res.cookie('token', token, {
            httpOnly: true, // Prevents client-side JS from reading the cookie
            secure: process.env.NODE_ENV === 'production', // Use HTTPS in production
            sameSite: 'strict', // Mitigates CSRF attacks
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        });

        // 7. Send a success response with the user data
        res.status(201).json({
            message: 'User registered successfully!',
            user: newUser
        });
    } catch (error) {
        console.error('Registration Error:', error);
        res.status(500).json({ message: 'An internal server error occurred during registration.' });
    }
});

/**
 * POST /api/auth/forgot-password
 * Generates a password reset token and sends it to the user's email.
 */
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ message: 'Please provide an email address.' });
    }

    try {
        // 1. Find the user by email
        const userQuery = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = userQuery.rows[0];

        // SECURITY: Always send a generic success message, even if the user is not found.
        // This prevents attackers from checking which emails are registered in your system.
        if (!user) {
            return res.status(200).json({ message: 'If a user with that email exists, a password reset link has been sent.' });
        }

        // 2. Generate a random, unhashed token
        const resetToken = crypto.randomBytes(32).toString('hex');

        // 3. Hash the token and set an expiration date (e.g., 10 minutes from now)
        const passwordResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
        const passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        // 4. Save the hashed token and expiry date to the user's record in the database
        await pool.query(
            'UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
            [passwordResetToken, passwordResetExpires, user.id]
        );

        // 5. Create the reset URL for the email (this contains the unhashed token)
        const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;
        const message = `You are receiving this email because you (or someone else) have requested the reset of a password. Please make a POST request with your new password to: \n\n ${resetUrl} \n\nIf you did not request this, please ignore this email and your password will remain unchanged. This link is valid for 10 minutes.`;

        // 6. Send the email
        await sendEmail({
            to: user.email,
            subject: 'Your Password Reset Token',
            text: message,
        });

        res.status(200).json({ message: 'If a user with that email exists, a password reset link has been sent.' });

    } catch (error) {
        console.error('Forgot Password Error:', error);
        // In case of an error, invalidate any token that might have been set
        await pool.query("UPDATE users SET password_reset_token = NULL, password_reset_expires = NULL WHERE email = $1", [email]);
        res.status(500).json({ message: 'There was an error sending the email. Please try again later.' });
    }
});

/**
 * POST /api/auth/reset-password/:token
 * Verifies the token and updates the user's password.
 */
router.post('/reset-password/:token', async (req, res) => {
    const { password } = req.body;

    // 1. Hash the token from the URL parameter to match the one in the database
    const passwordResetToken = crypto.createHash('sha256').update(req.params.token).digest('hex');

    try {
        // 2. Find the user by the hashed token and check if it's not expired
        const userQuery = await pool.query(
            'SELECT * FROM users WHERE password_reset_token = $1 AND password_reset_expires > NOW()',
            [passwordResetToken]
        );

        const user = userQuery.rows[0];

        if (!user) {
            return res.status(400).json({ message: 'Token is invalid or has expired.' });
        }

        // 3. Hash the new password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        // 4. Update the user's password and clear the reset token fields
        await pool.query(
            'UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL WHERE id = $2',
            [password_hash, user.id]
        );

        // 5. Generate a new JWT to log the user in automatically
        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: '30d',
        });

        // 6. Send the token in a secure, httpOnly cookie
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        });

        // 7. Send a success response with user data (excluding password info)
        res.status(200).json({
            message: 'Password has been reset successfully.',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                created_at: user.created_at
            }
        });
    } catch (error) {
        console.error('Reset Password Error:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

/**
 * PATCH /api/auth/profile
 * Updates the current logged-in user's profile information (name, email).
 */
router.patch('/profile', protect, async (req, res) => {
    const { name, email } = req.body;
    const userId = req.user.id;

    // 1. Basic validation: Ensure at least one field is being updated.
    if (!name && !email) {
        return res.status(400).json({ message: 'Please provide a name or email to update.' });
    }

    try {
        // 2. If email is being updated, validate it and check for conflicts.
        if (email && email !== req.user.email) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return res.status(400).json({ message: 'Please provide a valid email address.' });
            }

            const existingUserQuery = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
            if (existingUserQuery.rows.length > 0) {
                return res.status(409).json({ message: 'This email is already in use by another account.' });
            }
        }

        // 3. Dynamically build the UPDATE query based on the fields provided.
        const fieldsToUpdate = [];
        const values = [];
        let queryParamIndex = 1;

        if (name) {
            fieldsToUpdate.push(`name = $${queryParamIndex++}`);
            values.push(name);
        }

        if (email) {
            fieldsToUpdate.push(`email = $${queryParamIndex++}`);
            values.push(email);
        }

        // Add the user ID for the WHERE clause
        values.push(userId);

        const updateQuery = `
            UPDATE users 
            SET ${fieldsToUpdate.join(', ')} 
            WHERE id = $${queryParamIndex} 
            RETURNING id, name, email, created_at
        `;

        // 4. Execute the query and return the updated user data.
        const updatedUserQuery = await pool.query(updateQuery, values);

        res.status(200).json({
            message: 'Profile updated successfully.',
            user: updatedUserQuery.rows[0]
        });
    } catch (error) {
        console.error('Profile Update Error:', error);
        res.status(500).json({ message: 'An internal server error occurred while updating your profile.' });
    }
});

/**
 * GET /api/auth/logout
 * Logs the user out by clearing the authentication cookie.
 */
router.get('/logout', (req, res) => {
    // To clear a cookie, you must provide the same options (path, domain, etc.)
    // that were used when the cookie was set.
    res.clearCookie('token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
    });
    res.status(200).json({ message: 'User logged out successfully.' });
});

module.exports = router;