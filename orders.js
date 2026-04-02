const pool = require('./db'); 

/**
 * Creates a new pending order in the database before payment completion.
 * @param {number} userId - The user's ID.
 * @param {string} stripePaymentIntentId - The Stripe PaymentIntent ID.
 * @param {number} amountInCents - The order total in cents.
 * @param {string} currency - The currency code.
 * @param {Array} items - The array of line items.
 * @returns {Promise<object>} The newly created pending order.
 */
const createPendingOrder = async (userId, stripePaymentIntentId, amountInCents, currency, items) => {
    // Use a transaction to ensure both the order and its items are saved together
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const orderQuery = `
            INSERT INTO orders (user_id, stripe_payment_intent_id, amount, currency, status)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (stripe_payment_intent_id) DO NOTHING -- Prevents duplicate orders from duplicate webhooks
            RETURNING *;
        `;

        const orderValues = [userId, stripePaymentIntentId, amountInCents, currency, 'pending'];
        const { rows } = await client.query(orderQuery, orderValues);
        const newOrder = rows[0];

        // If the order was successfully inserted (not a duplicate) and we have items
        if (newOrder && items && items.length > 0) {
            for (const item of items) {
                await client.query(
                    `INSERT INTO order_items (order_id, description, quantity, unit_price, total_price)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [newOrder.id, item.description, item.quantity, item.unit_price, item.total_price]
                );
            }
        }

        await client.query('COMMIT');
        return newOrder;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

/**
 * Updates an order's status when the payment succeeds.
 * @param {string} stripePaymentIntentId - The Stripe PaymentIntent ID.
 * @param {string} status - The new status (e.g., 'succeeded').
 * @returns {Promise<object>} The updated order.
 */
const fulfillOrder = async (stripePaymentIntentId, status) => {
    const query = `
        UPDATE orders
        SET status = $1
        WHERE stripe_payment_intent_id = $2 AND status != $1
        RETURNING *;
    `;
    const { rows } = await pool.query(query, [status, stripePaymentIntentId]);
    return rows[0]; // Returns undefined if already updated
};

module.exports = {
    createPendingOrder,
    fulfillOrder,
};