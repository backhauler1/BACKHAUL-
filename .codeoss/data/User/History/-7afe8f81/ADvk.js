const pool = require('./db'); 

/**
 * Creates a new order in the database after a successful payment.
 * @param {object} paymentIntent - The successful PaymentIntent object from Stripe.
 * @returns {Promise<object>} The newly created order from the database.
 */
const createOrder = async (paymentIntent) => {
    const { id: stripePaymentIntentId, amount, currency, metadata } = paymentIntent;
    const { userId } = metadata;

    // The amount is already in cents from Stripe, which is perfect for integer storage.
    const amountInCents = amount;

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

        const orderValues = [userId, stripePaymentIntentId, amountInCents, currency, paymentIntent.status];
        const { rows } = await client.query(orderQuery, orderValues);
        const newOrder = rows[0];

        // If the order was successfully inserted (not a duplicate) and we have items
        if (newOrder && metadata.items) {
            const items = JSON.parse(metadata.items);
            
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

module.exports = {
    createOrder,
};