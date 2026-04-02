const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('./db');
const { authLimiter } = require('./rateLimiter');
const { z } = require('zod');
const logger = require('./logger');
const validate = require('./validate');

const router = express.Router();

const registerSchema = z.object({
    name: z.string({ required_error: 'Name is required.' }).min(1, 'Name is required.'),
    email: z.string({ required_error: 'Email is required.' }).email('Invalid email address.'),
    password: z.string({ required_error: 'Password is required.' }).min(8, 'Password must be at least 8 characters long.'),
    referralCode: z.string().optional()
});

/**
 * POST /api/auth/register
 * Creates a new user account.
 */
router.post('/register', authLimiter, validate({ body: registerSchema }), async (req, res) => {
    const { name, email, password, referralCode } = req.body;

    try {
        // 2. Check if user already exists
        const existingUserQuery = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUserQuery.rows.length > 0) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }

        // 2b. Check if the provided referral code is valid
        let referredById = null;
        if (referralCode) {
            const referrerQuery = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
            if (referrerQuery.rows.length === 0) {
                return res.status(400).json({ message: 'Invalid referral code.' });
            }
            referredById = referrerQuery.rows[0].id;
        }

        // 3. Hash the password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Generate a random 8-character alphanumeric referral code for the new user
        const newReferralCode = crypto.randomBytes(4).toString('hex').toUpperCase();

        // 4. Insert the new user into the database with a default 'user' role
        const newUserQuery = await pool.query(
            `INSERT INTO users (name, email, password, roles, referral_code, referred_by_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, roles`,
            [name, email, hashedPassword, ['user'], newReferralCode, referredById]
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