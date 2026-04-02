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

const suspendSchema = z.object({
    suspend: z.boolean()
});

/**
 * PATCH /api/users/:id/suspend
 * Toggles a user's suspension status.
 */
router.patch('/:id/suspend', protect, authorize('admin'), validate({ params: numericParamSchema('id'), body: suspendSchema }), async (req, res) => {
    const userId = req.params.id;
    const { suspend } = req.body;

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
            const actionMessage = suspend 
                ? 'Your account has been suspended by an administrator due to policy violations or excessive penalties. Please contact support for more information.' 
                : 'Your account access has been restored. You may now log in and resume using our services.';
                
            const emailOptions = {
                to: updatedUser.email,
                subject: `Account Status Update: ${actionText}`,
                text: `Hi ${updatedUser.name},\n\n${actionMessage}\n\nBest,\nYour App Team`,
                html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Account Status Update</h2><p>Hi ${updatedUser.name},</p><p>${actionMessage}</p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
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

module.exports = router;