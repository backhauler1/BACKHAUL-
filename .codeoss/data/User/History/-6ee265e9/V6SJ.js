const express = require('express');
const router = express.Router();

// The secret key is read from your .env file
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const { protect } = require('./auth'); // Assuming auth.js is in the same directory
const { createPendingOrder, fulfillOrder } = require('./orders');
const sendEmail = require('./email');
const pool = require('./db');

// --- Routes ---

/**
 * GET /api/stripe/config
 * Provides the Stripe publishable key to the frontend. This is safe to expose.
 */
router.get('/config', (req, res) => {
    if (!process.env.STRIPE_PUBLIC_KEY) {
        console.error("Stripe public key is not set in .env file");
        return res.status(500).json({ message: 'Server configuration error.' });
    }
    res.json({ publishableKey: process.env.STRIPE_PUBLIC_KEY });
});

/**
 * Securely calculates the total order amount and reconstructs the items array.
 * NEVER trust prices or totals sent from the client.
 */
const calculateOrderAmountAndItems = async (frontendItems) => {
    let totalAmountInCents = 0;
    const trustedItems = [];

    // Extract all requested item IDs
    const itemIds = frontendItems.map(item => item.id);

    // Fetch all matching active products from the database in a single query
    const { rows: products } = await pool.query(
        'SELECT id, name, price_cents FROM products WHERE id = ANY($1) AND is_active = true',
        [itemIds]
    );

    // Create a lookup map for fast access
    const productMap = {};
    for (const product of products) {
        productMap[product.id] = product;
    }

    for (const item of frontendItems) {
        const product = productMap[item.id];

        if (!product) {
            throw new Error(`Invalid or inactive item ID: ${item.id}`);
        }

        const trustedUnitPriceInCents = product.price_cents;
        const description = product.name;

        // Validate the quantity
        const quantity = parseInt(item.quantity, 10);
        if (isNaN(quantity) || quantity <= 0) throw new Error('Invalid quantity for item.');

        const itemTotal = trustedUnitPriceInCents * quantity;
        totalAmountInCents += itemTotal;

        // Build a sanitized item object to save to your database.
        // This ignores any malicious unit_price or description sent by the frontend.
        trustedItems.push({
            id: item.id,
            description: description,
            quantity: quantity,
            unit_price: trustedUnitPriceInCents,
            total_price: itemTotal
        });
    }

    return { amountInCents: totalAmountInCents, trustedItems };
};

/**
 * POST /api/stripe/create-payment-intent
 * Creates a new payment intent for a transaction. This is a protected route.
 */
router.post('/create-payment-intent', protect, async (req, res) => {
    const { items } = req.body;

    try {
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'Cart is empty.' });
        }

        // 1. Recalculate the amount securely on the server
        const { amountInCents, trustedItems } = await calculateOrderAmountAndItems(items);

        // Create a PaymentIntent with the order amount and currency.
        // The amount is in the smallest currency unit (e.g., cents for USD).
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: 'usd',
            // Stripe enables modern payment methods by default.
            automatic_payment_methods: {
                enabled: true,
            },
            // Associate the payment with the logged-in user from the `protect` middleware
            metadata: {
                userId: req.user.id,
            }
        });

        // Save the pending order and its items in our database immediately
        await createPendingOrder(req.user.id, paymentIntent.id, amountInCents, 'usd', trustedItems);

        // Send the client_secret to the client.
        // The client will use this to confirm the payment with Stripe.js.
        res.status(200).json({
            clientSecret: paymentIntent.client_secret,
        });

    } catch (error) {
        console.error('Stripe Payment Intent Error:', error);
        res.status(500).json({ message: 'Internal server error while creating payment intent.' });
    }
});

/**
 * POST /api/stripe/webhook
 * Listens for events from Stripe to handle asynchronous payment updates.
 * This is the endpoint you provide in your Stripe dashboard.
 */
router.post('/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        // The `req.body` is the raw buffer thanks to the middleware in server.js
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`❌ Webhook signature verification failed.`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            console.log(`✅ PaymentIntent for ${paymentIntent.amount} was successful!`);
            
            try {
                const fulfilledOrder = await fulfillOrder(paymentIntent.id, paymentIntent.status);

                // If the order was newly created (not from a duplicate webhook)
                if (fulfilledOrder) {
                    console.log(`📦 Order ${fulfilledOrder.id} for PaymentIntent ${paymentIntent.id} fulfilled successfully.`);

                    // Now, send the confirmation email
                    try {
                        const userQuery = await pool.query('SELECT email, name FROM users WHERE id = $1', [fulfilledOrder.user_id]);
                        const user = userQuery.rows[0];

                        if (user) {
                            const amountInDollars = (fulfilledOrder.amount / 100).toFixed(2);
                            const emailOptions = {
                                to: user.email,
                                subject: `Order Confirmation #${fulfilledOrder.id}`,
                                text: `Hi ${user.name},\n\nThank you for your purchase! We've received your payment of $${amountInDollars}.\n\nYour order ID is: ${fulfilledOrder.id}\n\nWe will notify you again once your order is processed.\n\nBest,\nYour App Team`,
                                html: `
                                    <div style="font-family: sans-serif; line-height: 1.6;">
                                        <h2>Order Confirmation</h2>
                                        <p>Hi ${user.name},</p>
                                        <p>Thank you for your purchase! We've received your payment of <strong>$${amountInDollars}</strong>.</p>
                                        <p>Your order ID is: <strong>${fulfilledOrder.id}</strong></p>
                                        <p>We will notify you again once your order is processed.</p>
                                        <br>
                                        <p>Best,</p>
                                        <p><strong>Your App Team</strong></p>
                                    </div>
                                `
                            };
                            await sendEmail(emailOptions);
                            console.log(`✉️ Confirmation email sent to ${user.email} for order ${fulfilledOrder.id}.`);
                        } else {
                            console.error(`🚨 Could not find user with ID ${fulfilledOrder.user_id} to send confirmation email.`);
                        }
                    } catch (emailError) {
                        console.error(`🚨 Failed to send confirmation email for order ${fulfilledOrder.id}:`, emailError);
                        // Do not re-throw. The order was saved, which is the critical part.
                    }
                } else {
                    console.log(`- Duplicate webhook for PaymentIntent ${paymentIntent.id}. Order already exists. No action taken.`);
                }
            } catch (dbError) {
                console.error(`🚨 Database error fulfilling order for PI ${paymentIntent.id}:`, dbError);
                return res.status(500).json({ error: 'Database update failed' });
            }
            break;
        case 'charge.refunded':
            const charge = event.data.object;
            // The payment_intent property on a charge object contains the ID
            const refundPaymentIntentId = charge.payment_intent;
            
            if (refundPaymentIntentId) {
                console.log(`💸 Charge refunded for PaymentIntent ${refundPaymentIntentId}. Updating order status...`);
                try {
                    // Reusing our fulfillOrder function to update the status to 'refunded'
                    const updatedOrder = await fulfillOrder(refundPaymentIntentId, 'refunded');
                    if (updatedOrder) {
                        console.log(`📦 Order ${updatedOrder.id} marked as refunded.`);

                        // Send refund email
                        try {
                            const userQuery = await pool.query('SELECT email, name FROM users WHERE id = $1', [updatedOrder.user_id]);
                            const user = userQuery.rows[0];

                            if (user) {
                                const amountInDollars = (updatedOrder.amount / 100).toFixed(2);
                                const emailOptions = {
                                    to: user.email,
                                    subject: `Order Refunded #${updatedOrder.id}`,
                                    text: `Hi ${user.name},\n\nYour order #${updatedOrder.id} has been successfully refunded.\nAn amount of $${amountInDollars} will be returned to your original payment method shortly.\n\nBest,\nYour App Team`,
                                    html: `
                                        <div style="font-family: sans-serif; line-height: 1.6;">
                                            <h2>Order Refunded</h2>
                                            <p>Hi ${user.name},</p>
                                            <p>Your order <strong>#${updatedOrder.id}</strong> has been successfully refunded.</p>
                                            <p>An amount of <strong>$${amountInDollars}</strong> will be returned to your original payment method shortly.</p>
                                            <br>
                                            <p>Best,</p>
                                            <p><strong>Your App Team</strong></p>
                                        </div>
                                    `
                                };
                                await sendEmail(emailOptions);
                                console.log(`✉️ Refund email sent to ${user.email} for order ${updatedOrder.id}.`);
                            }
                        } catch (emailError) {
                            console.error(`🚨 Failed to send refund email for order ${updatedOrder.id}:`, emailError);
                        }
                    } else {
                        console.log(`- Order for PaymentIntent ${refundPaymentIntentId} already marked as refunded or not found.`);
                    }
                } catch (error) {
                    console.error(`🚨 Database error updating order for refund:`, error);
                }
            }
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    // Return a 200 response to acknowledge receipt of the event
    res.json({ received: true });
});

module.exports = router;