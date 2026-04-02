const { pool } = require('./db'); // Assuming db.js exports a 'pool'

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

    const query = `
        INSERT INTO orders (user_id, stripe_payment_intent_id, amount, currency, status)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (stripe_payment_intent_id) DO NOTHING -- Prevents duplicate orders from duplicate webhooks
        RETURNING *;
    `;

    const values = [
        userId,
        stripePaymentIntentId,
        amountInCents,
        currency,
        paymentIntent.status // e.g., 'succeeded'
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
};

module.exports = {
    createOrder,
};