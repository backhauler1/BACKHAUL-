const request = require('supertest');
const express = require('express');

// 1. Mock the Stripe library to intercept webhook signature validation
jest.mock('stripe', () => {
    const mockStripe = {
        webhooks: {
            constructEvent: jest.fn(),
        },
        paymentIntents: {
            create: jest.fn(),
        }
    };
    // Returning a factory function ensures that when stripe.js calls require('stripe')('sk_test_...'), 
    // it receives this exact mockStripe object instance.
    return jest.fn(() => mockStripe);
});

// 2. Mock Database, Email, and Order functions
jest.mock('./db', () => ({
    query: jest.fn(),
}));
jest.mock('./email', () => jest.fn());
jest.mock('./orders', () => ({
    createPendingOrder: jest.fn(),
    fulfillOrder: jest.fn(),
}));
jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        req.user = { id: 1 };
        next();
    },
}));

const stripeRouter = require('./stripe');
const stripe = require('stripe');
const mockStripeInstance = stripe();
const pool = require('./db');
const sendEmail = require('./email');
const { fulfillOrder } = require('./orders');

// 3. Set up a minimal Express app to test the router
const app = express();
// Important: Must match the middleware configuration in server.js! Stripe needs the raw buffer.
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/stripe', stripeRouter);

describe('Stripe Webhook Event Handling', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Suppress console output to keep test logs clean
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should process payment_intent.succeeded and send a confirmation email', async () => {
        // 1. Setup the mock event that constructEvent should return
        const mockEvent = {
            type: 'payment_intent.succeeded',
            data: {
                object: { id: 'pi_test_123', amount: 5000, status: 'succeeded' }
            }
        };
        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(mockEvent);

        // 2. Setup database and order logic responses
        fulfillOrder.mockResolvedValueOnce({ id: 99, user_id: 1, amount: 5000, status: 'succeeded' });
        pool.query.mockResolvedValueOnce({ rows: [{ email: 'test@example.com', name: 'Test User' }] });

        // 3. Send the simulated webhook request
        const res = await request(app)
            .post('/api/stripe/webhook')
            .set('stripe-signature', 'valid_test_signature')
            .send(JSON.stringify({ dummy: 'payload' })); // Sending generic JSON because constructEvent intercepts it anyway

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ received: true });
        
        // 4. Verify Side Effects
        expect(fulfillOrder).toHaveBeenCalledWith('pi_test_123', 'succeeded');
        expect(pool.query).toHaveBeenCalledWith('SELECT email, name FROM users WHERE id = $1', [1]);
        
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const emailArgs = sendEmail.mock.calls[0][0];
        expect(emailArgs.to).toBe('test@example.com');
        expect(emailArgs.subject).toBe('Order Confirmation #99');
    });

    it('should return 400 if the webhook signature is invalid', async () => {
        // Simulate a Stripe signature validation error
        mockStripeInstance.webhooks.constructEvent.mockImplementationOnce(() => {
            throw new Error('Invalid signature');
        });

        const res = await request(app)
            .post('/api/stripe/webhook')
            .set('stripe-signature', 'invalid_test_signature')
            .send(JSON.stringify({ dummy: 'payload' }));

        expect(res.statusCode).toBe(400);
        expect(res.text).toBe('Webhook Error: Invalid signature');
        expect(fulfillOrder).not.toHaveBeenCalled(); // Ensure the order wasn't processed
    });

    it('should process charge.refunded and send a refund confirmation email', async () => {
        // 1. Setup the mock event that constructEvent should return for a refund
        const mockEvent = {
            type: 'charge.refunded',
            data: {
                // A charge object typically nests the payment intent ID under `payment_intent`
                object: { payment_intent: 'pi_test_123', amount_refunded: 5000 }
            }
        };
        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(mockEvent);

        // 2. Setup database and order logic responses
        fulfillOrder.mockResolvedValueOnce({ id: 100, user_id: 1, amount: 5000, status: 'refunded' });
        pool.query.mockResolvedValueOnce({ rows: [{ email: 'test@example.com', name: 'Test User' }] });

        // 3. Send the simulated webhook request
        const res = await request(app)
            .post('/api/stripe/webhook')
            .set('stripe-signature', 'valid_test_signature')
            .send(JSON.stringify({ dummy: 'payload' }));

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ received: true });
        
        // 4. Verify Side Effects
        expect(fulfillOrder).toHaveBeenCalledWith('pi_test_123', 'refunded');
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const emailArgs = sendEmail.mock.calls[0][0];
        expect(emailArgs.subject).toBe('Order Refunded #100');
    });
});