const request = require('supertest');
const express = require('express');
const pool = require('./db');

// 1. Mock Database
jest.mock('./db', () => ({
    query: jest.fn(),
    connect: jest.fn(),
}));

// 2. Mock Authentication Middleware
jest.mock('./middleware/auth', () => ({
    protect: (req, res, next) => {
        req.user = { id: 1 };
        next();
    },
}));

// 3. Mock Stripe and Email (Required because orderRoutes.js initializes Stripe on load)
const mockStripeInstance = {
    refunds: { create: jest.fn() },
};
jest.mock('stripe', () => {
    return jest.fn(() => mockStripeInstance);
});
const sendEmail = require('./email');
jest.mock('./email', () => jest.fn());

const orderRoutes = require('./orderRoutes');
const app = express();
app.use(express.json());
app.use('/api/orders', orderRoutes);

describe('Order Routes - GET Endpoints', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();

        // Setup mock client for pool.connect() used in the /history route
        mockClient = {
            query: jest.fn(),
            release: jest.fn(),
        };
        pool.connect.mockResolvedValue(mockClient);
        
        // Suppress console error logs during failed request tests to keep terminal clean
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    describe('GET /api/orders/history', () => {
        it('should return paginated order history for the authenticated user', async () => {
            // Mock Query 1: Total count of items
            mockClient.query.mockResolvedValueOnce({ rows: [{ count: '15' }] });
            
            // Mock Query 2: Paginated orders array
            const mockOrders = [
                { id: 101, amount: 5000, currency: 'usd', status: 'succeeded', created_at: new Date().toISOString() },
                { id: 102, amount: 2500, currency: 'usd', status: 'pending', created_at: new Date().toISOString() }
            ];
            mockClient.query.mockResolvedValueOnce({ rows: mockOrders });

            // Request page 2 with a limit of 10 items
            const res = await request(app).get('/api/orders/history?page=2&limit=10');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Successfully retrieved order history.');
            expect(res.body.data).toEqual(mockOrders);
            
            // Verify pagination calculation logic
            expect(res.body.pagination).toEqual({
                currentPage: 2,
                totalPages: 2, // 15 total items / 10 limit = 1.5 -> Math.ceil = 2 pages
                totalItems: 15,
            });

            // Verify the database client executed both queries with the correct parameters
            expect(mockClient.query).toHaveBeenCalledTimes(2);
            expect(mockClient.query.mock.calls[0][0]).toContain('SELECT COUNT(*)');
            expect(mockClient.query.mock.calls[0][1]).toEqual([1]); // user_id = 1
            
            expect(mockClient.query.mock.calls[1][0]).toContain('LIMIT $2 OFFSET $3');
            expect(mockClient.query.mock.calls[1][1]).toEqual([1, 10, 10]); // user_id = 1, limit = 10, offset = 10
            
            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });

        it('should handle database errors gracefully and release the client back to the pool', async () => {
            mockClient.query.mockRejectedValueOnce(new Error('DB Error'));

            const res = await request(app).get('/api/orders/history');

            expect(res.statusCode).toBe(500);
            expect(res.body.message).toBe('Internal server error while fetching order history.');
            
            // CRITICAL: Ensure the client is still released even if an exception was thrown
            expect(mockClient.release).toHaveBeenCalledTimes(1); 
        });
    });

    describe('GET /api/orders/:orderId', () => {
        it('should return order details and associated items', async () => {
            const mockOrder = { id: 101, amount: 5000, currency: 'usd', status: 'succeeded', created_at: new Date().toISOString() };
            const mockItems = [{ description: 'Premium Listing', quantity: 1, unit_price: 5000, total_price: 5000 }];

            pool.query.mockResolvedValueOnce({ rows: [mockOrder] }); // Order query
            pool.query.mockResolvedValueOnce({ rows: mockItems });   // Items query

            const res = await request(app).get('/api/orders/101');

            expect(res.statusCode).toBe(200);
            expect(res.body.data).toEqual({ ...mockOrder, items: mockItems });
            
            // Verify database queried the correct user and order combination
            expect(pool.query).toHaveBeenCalledTimes(2);
            expect(pool.query.mock.calls[0][1]).toEqual(['101', 1]); 
        });

        it('should return 404 if the order does not exist or belongs to another user', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] }); // No order found

            const res = await request(app).get('/api/orders/999');

            expect(res.statusCode).toBe(404);
            expect(res.body.message).toBe('Order not found or unauthorized.');
        });
    });

    describe('GET /api/orders/invoice/:orderId/pdf', () => {
        it('should generate and stream a PDF invoice for a valid order', async () => {
            const mockOrder = {
                id: 101,
                amount: 5000,
                currency: 'usd',
                status: 'succeeded',
                created_at: new Date().toISOString(),
                user_name: 'Test User',
                user_email: 'test@example.com'
            };
            const mockItems = [{ description: 'Premium Listing', quantity: 1, unit_price: 5000, total_price: 5000 }];

            pool.query.mockResolvedValueOnce({ rows: [mockOrder] }); // Order query
            pool.query.mockResolvedValueOnce({ rows: mockItems });   // Items query

            const res = await request(app)
                .get('/api/orders/invoice/101/pdf')
                .responseType('blob'); // Instruct supertest to treat the response as a binary buffer

            expect(res.statusCode).toBe(200);
            
            // Verify download headers are correctly configured
            expect(res.headers['content-type']).toBe('application/pdf');
            expect(res.headers['content-disposition']).toBe('attachment; filename="invoice-000101.pdf"');
            
            // Verify that the response is a buffer and begins with the PDF file signature
            expect(Buffer.isBuffer(res.body)).toBe(true);
            expect(res.body.toString('utf8', 0, 5)).toBe('%PDF-');
        });

        it('should return 404 if the invoice is not found or unauthorized', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] }); // No order found
            const res = await request(app).get('/api/orders/invoice/999/pdf');
            expect(res.statusCode).toBe(404);
            expect(res.body.message).toBe('Invoice not found or you do not have permission to view it.');
        });
    });

    describe('POST /api/orders/:orderId/cancel', () => {
        it('should successfully cancel an order, issue a Stripe refund, and send an email', async () => {
            const mockOrder = { id: 101, stripe_payment_intent_id: 'pi_123', status: 'succeeded', amount: 5000 };
            const mockUser = { email: 'test@example.com', name: 'Test User' };

            // Mock DB: 1. Fetch order, 2. Update order status, 3. Fetch user for email
            pool.query.mockResolvedValueOnce({ rows: [mockOrder] });
            pool.query.mockResolvedValueOnce({ rowCount: 1 });
            pool.query.mockResolvedValueOnce({ rows: [mockUser] });

            mockStripeInstance.refunds.create.mockResolvedValueOnce({ id: 're_123' });

            const res = await request(app).post('/api/orders/101/cancel');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Order successfully cancelled and refunded.');

            // Verify Stripe refund was initiated with the correct Payment Intent ID
            expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_123' });

            // Verify Database update query
            expect(pool.query.mock.calls[1][0]).toContain("UPDATE orders SET status = 'refunded'");
            expect(pool.query.mock.calls[1][1]).toEqual(['101']);

            // Verify confirmation email was sent
            expect(sendEmail).toHaveBeenCalledTimes(1);
            expect(sendEmail.mock.calls[0][0].to).toBe('test@example.com');
            expect(sendEmail.mock.calls[0][0].subject).toBe('Order Refunded #101');
        });

        it('should return 400 if the order status is not succeeded', async () => {
            const mockOrder = { id: 102, stripe_payment_intent_id: 'pi_124', status: 'pending', amount: 2500 };
            pool.query.mockResolvedValueOnce({ rows: [mockOrder] }); // Order query

            const res = await request(app).post('/api/orders/102/cancel');

            expect(res.statusCode).toBe(400);
            expect(res.body.message).toBe("Order cannot be refunded because its status is 'pending'.");
            expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
        });

        it('should return 404 if the order does not exist or belongs to another user', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] }); // No order found

            const res = await request(app).post('/api/orders/999/cancel');

            expect(res.statusCode).toBe(404);
            expect(res.body.message).toBe('Order not found or unauthorized.');
            expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
        });
    });
});