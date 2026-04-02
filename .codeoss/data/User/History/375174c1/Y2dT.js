const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { authLimiter } = require('./middleware/rateLimiter');

const router = express.Router();

/**
 * POST /api/auth/register
 * Creates a new user account.
 */
router.post('/register', authLimiter, async (req, res) => {
    const { name, email, password } = req.body;

    // 1. Basic validation
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Name, email, and password are required.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    try {
        // 2. Check if user already exists
        const existingUserQuery = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUserQuery.rows.length > 0) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }

        // 3. Hash the password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // 4. Insert the new user into the database with a default 'user' role
        const newUserQuery = await pool.query(
            `INSERT INTO users (name, email, password, roles) VALUES ($1, $2, $3, $4) RETURNING id, name, email, roles`,
            [name, email, hashedPassword, ['user']]
        );

        const newUser = newUserQuery.rows[0];

        // 5. Send a success response. We do not log the user in automatically.
        res.status(201).json({ message: 'User registered successfully. Please log in.' });

    } catch (error) {
        console.error('Registration Error:', error);
        res.status(500).json({ message: 'Internal server error during registration.' });
    }
});

module.exports = router;