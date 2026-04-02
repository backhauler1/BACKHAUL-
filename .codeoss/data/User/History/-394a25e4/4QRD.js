const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db'); // Adjust path depending on your folder structure

const router = express.Router();

/**
 * POST /api/auth/register
 * Registers a new user, hashes their password, and sets an auth cookie.
 */
router.post('/register', async (req, res) => {
    const { name, email, password } = req.body;

    // 1. Basic input validation
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Please provide name, email, and password.' });
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