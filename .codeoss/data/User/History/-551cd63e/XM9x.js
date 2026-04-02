const express = require('express');
const pool = require('./db');
const { protect, authorize } = require('./auth');
const validate = require('./validate');
const { numericParamSchema } = require('./commonSchemas');
const { z } = require('zod');
const redisClient = require('./redis');
const sendEmail = require('./email');

const router = express.Router();

const paginationQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(50).default(15),
    search: z.string().optional()
});

/**
 * GET /api/users
 * Fetches a paginated list of users for admin management.
 */
router.get('/', protect, authorize('admin'), validate({ query: paginationQuerySchema }), async (req, res) => {
    const { page, limit, search } = req.query;
    const offset = (page - 1) * limit;

    try {
        let countQuery = 'SELECT COUNT(*) FROM users';
        let queryStr = `
            SELECT id, name, email, roles, penalty_count, is_suspended, created_at 
            FROM users
        `;

        const countParams = [];
        const queryParams = [];
        let paramIndex = 1;

        // Allow admins to search by email or name
        if (search) {
            const searchClause = ` WHERE email ILIKE $1 OR name ILIKE $1`;
            countQuery += searchClause;
            queryStr += searchClause;
            countParams.push(`%${search}%`);
            queryParams.push(`%${search}%`);
            paramIndex++;
        }

        const { rows: countRows } = await pool.query(countQuery, countParams);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit) || 1;

        // Order by penalty_count DESC so the riskiest users show up first!
        queryStr += ` ORDER BY penalty_count DESC NULLS LAST, created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        queryParams.push(limit, offset);

        const { rows: users } = await pool.query(queryStr, queryParams);

        res.status(200).json({
            data: users,
            pagination: { currentPage: page, totalPages, totalItems }
        });
    } catch (error) {
        console.error('Fetch Users Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching users.' });
    }
});

/**
 * GET /api/users/admin/top-referrers
 * Fetches a paginated list of top referring users for the admin dashboard.
 */
router.get('/admin/top-referrers', protect, authorize('admin'), validate({ query: paginationQuerySchema }), async (req, res) => {
    const { page, limit } = req.query;
    const offset = (page - 1) * limit;

    try {
        // Count total number of unique referrers who have successful referrals for pagination
        const countQuery = `
            SELECT COUNT(DISTINCT r.referred_by_id) 
            FROM users r 
            JOIN orders o ON r.id = o.user_id 
            WHERE r.referred_by_id IS NOT NULL AND o.status = 'succeeded'
        `;
        const { rows: countRows } = await pool.query(countQuery);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit) || 1;

        // Fetch the referrers, count their successful referrals, and sort descending
        const queryStr = `
            SELECT u.id, u.name, u.email, u.referral_code, COUNT(DISTINCT r.id)::int AS total_referrals
            FROM users u
            JOIN users r ON u.id = r.referred_by_id
            JOIN orders o ON r.id = o.user_id
            WHERE o.status = 'succeeded'
            GROUP BY u.id, u.name, u.email, u.referral_code
            ORDER BY total_referrals DESC, u.created_at DESC
            LIMIT $1 OFFSET $2
        `;
        const { rows: referrers } = await pool.query(queryStr, [limit, offset]);

        res.status(200).json({
            data: referrers,
            pagination: { currentPage: page, totalPages, totalItems }
        });
    } catch (error) {
        console.error('Fetch Top Referrers Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching top referrers.' });
    }
});

const suspendSchema = z.object({
    suspend: z.boolean(),
    reason: z.string().optional()
});

/**
 * PATCH /api/users/:id/suspend
 * Toggles a user's suspension status.
 */
router.patch('/:id/suspend', protect, authorize('admin'), validate({ params: numericParamSchema('id'), body: suspendSchema }), async (req, res) => {
    const userId = req.params.id;
    const { suspend, reason } = req.body;

    try {
        let updateQuery;
        if (suspend) {
            // Suspending increments token_version and removes the refresh_token to globally invalidate existing sessions
            updateQuery = `
                UPDATE users 
                SET is_suspended = true, token_version = COALESCE(token_version, 0) + 1, refresh_token = NULL 
                WHERE id = $1 RETURNING id, name, email, is_suspended
            `;
        } else {
            updateQuery = `
                UPDATE users 
                SET is_suspended = false 
                WHERE id = $1 RETURNING id, name, email, is_suspended
            `;
        }

        const { rows } = await pool.query(updateQuery, [userId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Invalidate the session in Redis to trigger immediate logout for the suspended user
        if (suspend) {
            await redisClient.del(`user:${userId}:token_version`).catch(err => console.error('Redis DEL error:', err));
        }

        // Send a notification email to the user regarding their account status change
        try {
            const updatedUser = rows[0];
            const actionText = suspend ? 'Suspended' : 'Restored';
            
            const actionMessageText = suspend 
                ? `Your account has been suspended by an administrator.${reason ? `\n\nReason: ${reason}` : ''}\n\nPlease contact support for more information.` 
                : 'Your account access has been restored. You may now log in and resume using our services.';
                
            const actionMessageHtml = suspend 
                ? `<p>Your account has been suspended by an administrator.</p>${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}<p>Please contact support for more information.</p>` 
                : '<p>Your account access has been restored. You may now log in and resume using our services.</p>';
                
            const emailOptions = {
                to: updatedUser.email,
                subject: `Account Status Update: ${actionText}`,
                text: `Hi ${updatedUser.name},\n\n${actionMessageText}\n\nBest,\nYour App Team`,
                html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Account Status Update</h2><p>Hi ${updatedUser.name},</p>${actionMessageHtml}<br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
            };
            await sendEmail(emailOptions);
        } catch (emailError) {
            console.error('Failed to send suspension notification email:', emailError);
        }

        const action = suspend ? 'suspended' : 'unsuspended';
        res.status(200).json({ message: `User account has been ${action}.`, data: rows[0] });
    } catch (error) {
        console.error('Suspend User Error:', error);
        res.status(500).json({ message: 'Internal server error while updating user status.' });
    }
});

/**
 * GET /api/users/me/referrals
 * Fetches the current user's referral code and the total number of users they have referred.
 */
router.get('/me/referrals', protect, async (req, res) => {
    const userId = req.user.id;

    try {
        // Fetch the user's personal referral code
        const userQuery = await pool.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
        if (userQuery.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Count how many users have this user's ID as their referred_by_id AND have completed a successful order
        const statsQuery = await pool.query(`
            SELECT COUNT(DISTINCT r.id) 
            FROM users r 
            JOIN orders o ON r.id = o.user_id 
            WHERE r.referred_by_id = $1 AND o.status = 'succeeded'
        `, [userId]);
        const referralCount = parseInt(statsQuery.rows[0].count, 10);

        res.status(200).json({ referralCode: userQuery.rows[0].referral_code, totalReferred: referralCount });
    } catch (error) {
        console.error('Fetch Referral Stats Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching referral stats.' });
    }
});

const localeSchema = z.object({
    locale: z.string().min(2, 'Locale code too short.').max(10, 'Locale code too long.')
});

/**
 * PATCH /api/users/me/locale
 * Updates the user's preferred language for automated emails.
 */
router.patch('/me/locale', protect, validate({ body: localeSchema }), async (req, res) => {
    const userId = req.user.id;
    const { locale } = req.body;

    try {
        await pool.query('UPDATE users SET preferred_locale = $1 WHERE id = $2', [locale, userId]);
        res.status(200).json({ message: 'Preferred language updated successfully.' });
    } catch (error) {
        console.error('Update Locale Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

/**
 * DELETE /api/users/me
 * Deletes (anonymizes) the current user's account for GDPR/CCPA compliance.
 */
router.delete('/me', protect, async (req, res) => {
    const userId = req.user.id;

    try {
        // Anonymize user data to preserve referential integrity (e.g., order history) 
        // while removing Personally Identifiable Information (PII).
        const anonymizeQuery = `
            UPDATE users 
            SET 
                name = 'Deleted User', 
                email = 'deleted_' || id || '@example.com', 
                password = 'deleted', 
                referral_code = NULL, 
                refresh_token = NULL, 
                token_version = COALESCE(token_version, 0) + 1,
                is_suspended = true,
                preferred_locale = NULL
            WHERE id = $1
        `;
        
        await pool.query(anonymizeQuery, [userId]);

        // Invalidate the session in Redis to immediately log them out across all devices
        await redisClient.del(`user:${userId}:token_version`).catch(err => console.error('Redis DEL error:', err));

        // Clear authentication cookies locally
        const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' };
        res.clearCookie('token', cookieOptions);
        res.clearCookie('refreshToken', cookieOptions);

        res.status(200).json({ message: 'Your account has been successfully deleted and your personal data has been anonymized.' });
    } catch (error) {
        console.error('Account Deletion Error:', error);
        res.status(500).json({ message: 'Internal server error during account deletion.' });
    }
});

/**
 * GET /api/users/:id/reviews
 * Fetches written reviews and the average rating summary for a specific user.
 */
router.get('/:id/reviews', validate({ params: numericParamSchema('id'), query: paginationQuerySchema }), async (req, res) => {
    const userId = req.params.id;
    const { page, limit } = req.query;
    const offset = (page - 1) * limit;
    
    const cacheKey = `user:${userId}:reviews:page:${page}:limit:${limit}`;

    try {
        // 1. Try fetching from Redis first
        try {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                return res.status(200).json(JSON.parse(cachedData));
            }
        } catch (redisErr) {
            console.error('Redis GET Error:', redisErr);
        }

        // Fetch user's average rating
        const userQuery = await pool.query('SELECT rating, rating_count FROM users WHERE id = $1', [userId]);
        const user = userQuery.rows[0];

        if (!user) return res.status(404).json({ message: 'User not found.' });

        // Fetch total count of *written* reviews to calculate pagination metadata
        const countQuery = `
            SELECT COUNT(*) FROM load_ratings 
            WHERE target_id = $1 AND review IS NOT NULL AND review != ''
        `;
        const { rows: countRows } = await pool.query(countQuery, [userId]);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit) || 1;

        // Fetch written reviews
        const reviewQuery = `
            SELECT r.load_id, r.rater_id, r.rating, r.review, r.created_at, u.name AS reviewer_name
            FROM load_ratings r
            JOIN users u ON r.rater_id = u.id
            WHERE r.target_id = $1 AND r.review IS NOT NULL AND r.review != ''
            ORDER BY r.created_at DESC
            LIMIT $2 OFFSET $3
        `;
        const { rows: reviews } = await pool.query(reviewQuery, [userId, limit, offset]);

        const responsePayload = { 
            data: reviews,
            summary: {
                averageRating: parseFloat(user.rating) || 0,
                totalRatings: user.rating_count || 0
            },
            pagination: { currentPage: page, totalPages, totalItems }
        };

        // 2. Save the result to Redis with a 60-second Time-To-Live (TTL)
        try {
            await redisClient.setEx(cacheKey, 60, JSON.stringify(responsePayload));
        } catch (redisErr) {
            console.error('Redis SET Error:', redisErr);
        }

        res.status(200).json(responsePayload);
    } catch (error) {
        console.error('Fetch Reviews Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching reviews.' });
    }
});

module.exports = router;