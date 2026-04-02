const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { fulfillOrder } = require('./orders');
const logger = require('./logger'); // Assuming you have a centralized logger

const router = express.Router();

// Stripe requires the raw body to construct the event, so we use express.raw
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        logger.error(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event successfully verified by Stripe
    try {
        switch (event.type) {
            case 'payment_intent.succeeded':
                const paymentIntentSucceeded = event.data.object;
                await fulfillOrder(paymentIntentSucceeded.id, 'succeeded');
                logger.info(`Order fulfilled for PaymentIntent ${paymentIntentSucceeded.id}`);
                break;
            
            case 'payment_intent.payment_failed':
                const paymentIntentFailed = event.data.object;
                await fulfillOrder(paymentIntentFailed.id, 'failed');
                logger.warn(`Payment failed for PaymentIntent ${paymentIntentFailed.id}`);
                break;
                
            default:
                logger.info(`Unhandled Stripe event type: ${event.type}`);
        }
        
        // Return a 200 response to acknowledge receipt of the event
        res.status(200).send();
    } catch (error) {
        logger.error(`Error processing webhook event: ${error.message}`);
        res.status(500).send('Internal Server Error processing webhook');
    }
});

module.exports = router;