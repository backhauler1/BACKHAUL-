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

    try {
        // Fetch all orders for the user from the database.
        // NOTE: This assumes your `orders` table has a `created_at` column.
        // If not, you can add one with: ALTER TABLE orders ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
        const ordersQuery = await pool.query(
            `SELECT 
                id, 
                amount, 
                currency, 
                status, 
                created_at 
             FROM orders 
             WHERE user_id = $1 
             ORDER BY created_at DESC`,
            [userId]
        );

        res.status(200).json({
            message: 'Successfully retrieved order history.',
            data: ordersQuery.rows,
        });

    } catch (error) {
        console.error('Get Order History Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching order history.' });
    }
});

module.exports = router;