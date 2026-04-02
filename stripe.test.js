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
        },
        coupons: {
            create: jest.fn(),
        },
        promotionCodes: {
            create: jest.fn(),
            list: jest.fn(),
            update: jest.fn(),
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
        pool.query
            .mockResolvedValueOnce({ rows: [{ email: 'test@example.com', name: 'Test User' }] }) // User for order confirmation
            .mockResolvedValueOnce({ rows: [{ referred_by_id: null }] }); // User referral check

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

    it('should process payment_intent.succeeded and issue a referral reward if it is their first order', async () => {
        const mockEvent = {
            type: 'payment_intent.succeeded',
            data: { object: { id: 'pi_test_124', amount: 5000, status: 'succeeded', metadata: { promoCodeId: 'promo_123' } } }
        };
        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(mockEvent);

        fulfillOrder.mockResolvedValueOnce({ id: 100, user_id: 2, amount: 5000, status: 'succeeded' });
        
        pool.query
            .mockResolvedValueOnce({ rows: [{ email: 'newuser@example.com', name: 'New User' }] }) // Order confirmation
            .mockResolvedValueOnce({ rows: [{ referred_by_id: 1 }] }) // Referral check (Referred by user 1)
            .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // Order count check (First order!)
            .mockResolvedValueOnce({ rows: [{ email: 'referrer@example.com', name: 'Referrer' }] }); // Fetch referrer

        mockStripeInstance.coupons.create.mockResolvedValueOnce({ id: 'COUPON_123' });
        mockStripeInstance.promotionCodes.create.mockResolvedValueOnce({ code: 'PROMO_CODE_ABC' });

        const res = await request(app)
            .post('/api/stripe/webhook')
            .set('stripe-signature', 'valid_test_signature')
            .send(JSON.stringify({ dummy: 'payload' }));

        expect(res.statusCode).toBe(200);
        
        expect(mockStripeInstance.coupons.create).toHaveBeenCalledWith(expect.objectContaining({ percent_off: 10 }));
        expect(mockStripeInstance.promotionCodes.create).toHaveBeenCalledWith({ coupon: 'COUPON_123', max_redemptions: 1 });
        
        // Verify the second email went to the referrer
        expect(sendEmail).toHaveBeenCalledTimes(2);
        const rewardEmailArgs = sendEmail.mock.calls[1][0];
        expect(rewardEmailArgs.to).toBe('referrer@example.com');
        expect(rewardEmailArgs.subject).toBe('You earned a 10% Referral Reward!');

        // Verify the promo code was deactivated
        expect(mockStripeInstance.promotionCodes.update).toHaveBeenCalledWith('promo_123', { active: false });
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

    it('should ignore duplicate payment_intent.succeeded events and not send duplicate emails', async () => {
        // 1. Setup the mock event
        const mockEvent = {
            type: 'payment_intent.succeeded',
            data: {
                object: { id: 'pi_test_duplicate', amount: 5000, status: 'succeeded' }
            }
        };
        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(mockEvent);

        // 2. Setup fulfillOrder to return undefined (simulating an order that's already 'succeeded')
        fulfillOrder.mockResolvedValueOnce(undefined);

        // 3. Send the simulated webhook request
        const res = await request(app)
            .post('/api/stripe/webhook')
            .set('stripe-signature', 'valid_test_signature')
            .send(JSON.stringify({ dummy: 'payload' }));

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ received: true });
        
        // 4. Verify Side Effects: fulfillOrder is called, but no email or further queries occur
        expect(fulfillOrder).toHaveBeenCalledWith('pi_test_duplicate', 'succeeded');
        expect(pool.query).not.toHaveBeenCalled();
        expect(sendEmail).not.toHaveBeenCalled();
    });
});