const express = require('express');
const pool = require('./db');
const { protect } = require('./middleware/auth');

const router = express.Router();

/**
 * GET /api/orders/history
 * Fetches the order history for the currently authenticated user.
 */
router.get('/history', protect, async (req, res) => {
    const userId = req.user.id;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10; // Default to 10 items per page
    const offset = (page - 1) * limit;

    try {
        // Use a single client for both queries to ensure data consistency
        const client = await pool.connect();
        try {
            // Query 1: Get the total count of orders for the user
            const totalItemsQuery = await client.query(
                `SELECT COUNT(*) FROM orders WHERE user_id = $1`,
                [userId]
            );
            const totalItems = parseInt(totalItemsQuery.rows[0].count, 10);
            const totalPages = Math.ceil(totalItems / limit);

            // Query 2: Fetch the paginated list of orders
            const ordersQuery = await client.query(
                `SELECT 
                    id, 
                    amount, 
                    currency, 
                    status, 
                    created_at 
                 FROM orders 
                 WHERE user_id = $1 
                 ORDER BY created_at DESC
                 LIMIT $2 OFFSET $3`,
                [userId, limit, offset]
            );

            res.status(200).json({
                message: 'Successfully retrieved order history.',
                data: ordersQuery.rows,
                pagination: {
                    currentPage: page,
                    totalPages,
                    totalItems,
                }
            });
        } finally {
            // Release the client back to the pool
            client.release();
        }
    } catch (error) {
        console.error('Get Order History Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching order history.' });
    }
});

module.exports = router;