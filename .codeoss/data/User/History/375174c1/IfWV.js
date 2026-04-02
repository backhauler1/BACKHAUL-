const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { authLimiter } = require('./rateLimiter');
const { z } = require('zod');
const logger = require('./logger');
const validate = require('./validate');

const router = express.Router();

const registerSchema = z.object({
    name: z.string({ required_error: 'Name is required.' }).min(1, 'Name is required.'),
    email: z.string({ required_error: 'Email is required.' }).email('Invalid email address.'),
    password: z.string({ required_error: 'Password is required.' }).min(8, 'Password must be at least 8 characters long.')
});

/**
 * POST /api/auth/register
 * Creates a new user account.
 */
router.post('/register', authLimiter, validate({ body: registerSchema }), async (req, res) => {
    const { name, email, password } = req.body;

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
        logger.error('Registration Error:', { error: error.message, stack: error.stack });
        res.status(500).json({ message: 'Internal server error during registration.' });
    }
});

module.exports = router;