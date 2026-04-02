const express = require('express');
const router = express.Router();

// The secret key is read from your .env file
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const { protect } = require('./auth');
const { createOrder } = require('./orders');

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
 * POST /api/stripe/create-payment-intent
 * Creates a new payment intent for a transaction. This is a protected route.
 */
router.post('/create-payment-intent', protect, async (req, res) => {
    // In a real application, you would calculate the amount based on items in a cart,
    // a subscription plan, or a specific service, rather than trusting the client.
    const { amount } = req.body;

    // Basic validation
    if (!amount || typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ message: 'A valid amount is required.' });
    }

    try {
        // Create a PaymentIntent with the order amount and currency.
        // The amount is in the smallest currency unit (e.g., cents for USD).
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100), // Convert dollars to cents
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
                await createOrder(paymentIntent);
                console.log(`📦 Order for PaymentIntent ${paymentIntent.id} created successfully.`);
            } catch (dbError) {
                console.error(`🚨 Database error fulfilling order for PI ${paymentIntent.id}:`, dbError);
                return res.status(500).json({ error: 'Database update failed' });
            }
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    // Return a 200 response to acknowledge receipt of the event
    res.json({ received: true });
});

module.exports = router;