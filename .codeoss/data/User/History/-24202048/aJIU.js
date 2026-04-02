const request = require('supertest');
const express = require('express');
const pool = require('./db');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const redisClient = require('./redis');

// 1. Mock the Database
jest.mock('./db', () => ({
    query: jest.fn(),
}));

// 2. Mock Redis Cache
jest.mock('./redis', () => ({
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
    sendCommand: jest.fn().mockResolvedValue(),
    connect: jest.fn(),
}));

// 3. Mock Middleware
jest.mock('./rateLimiter', () => ({
    authLimiter: (req, res, next) => next(),
}));
jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        req.user = { id: 1 };
        next();
    },
    requireVerification: (req, res, next) => next(),
}));

// 4. Mock Nodemailer
const mockSendMail = jest.fn().mockResolvedValue(true);
jest.mock('nodemailer', () => ({
    createTransport: jest.fn(() => ({
        sendMail: mockSendMail,
    })),
}));

// 5. Mock bcrypt to speed up test execution
jest.mock('bcrypt', () => ({
    ...jest.requireActual('bcrypt'),
    hash: jest.fn().mockResolvedValue('hashed_password_for_test'),
    compare: jest.fn().mockResolvedValue(true),
}));

const passwordResetRouter = require('./passwordReset');
const app = express();
app.use(express.json());
// Add a mock i18next `t` function to the request object for all tests
app.use((req, res, next) => {
    req.t = (key) => key; // Simple passthrough mock
    next();
});
app.use('/api/auth', passwordResetRouter);

describe('Password Reset API - Email Notifications', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        bcrypt.hash.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks(); // Clean up spies after each test
    });

    it('should generate a token and send a reset email when the user exists', async () => {
        // Spy on crypto.randomBytes to return a predictable buffer filled with 'a's
        jest.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.alloc(32, 'a'));
        const expectedToken = Buffer.alloc(32, 'a').toString('hex');

        // Mock DB: 1. Find user by email, 2. Update user with reset token
        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Test User' }] });
        pool.query.mockResolvedValueOnce({ rowCount: 1 });

        const res = await request(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'test@example.com' });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('auth.resetEmailSent');

        // Assert that nodemailer's sendMail was called with the correct details
        expect(mockSendMail).toHaveBeenCalledTimes(1);
        const mailOptions = mockSendMail.mock.calls[0][0];
        expect(mailOptions.to).toBe('test@example.com');
        expect(mailOptions.subject).toBe('Password Reset Request');
        expect(mailOptions.text).toContain('Hi Test User');
        expect(mailOptions.html).toContain(`reset-password?token=${expectedToken}`);
    });

    it('should return 200 without sending an email when the user does not exist (Email Enumeration Protection)', async () => {
        // Mock DB to consistently return no user for this test
        pool.query.mockResolvedValue({ rows: [] });

        const res = await request(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'nonexistent@example.com' });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('auth.resetEmailSent');
        
        // Ensure no email was actually sent
        expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('should correctly hash the provided token and compare it in the database during reset', async () => {
        const rawToken = 'my-secret-reset-token';
        
        // Manually compute the expected hash that the route should generate
        const expectedHashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

        // Mock DB: 1. Find user by email and valid token, 2. Update user's password
        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Test User' }] });
        pool.query.mockResolvedValueOnce({ rowCount: 1 });

        const res = await request(app)
            .post('/api/auth/reset-password')
            .send({
                email: 'test@example.com',
                token: rawToken,
                newPassword: 'newSecurePassword123'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Password has been successfully reset. You can now log in.');

        // Verify the database SELECT query used the securely hashed token instead of the raw token
        const selectQueryArgs = pool.query.mock.calls[0][1];
        expect(selectQueryArgs[0]).toBe('test@example.com');
        expect(selectQueryArgs[1]).toBe(expectedHashedToken);
        expect(selectQueryArgs[1]).not.toBe(rawToken);
    });

    describe('POST /api/auth/change-password', () => {
        it('should successfully update the password and invalidate the Redis cache', async () => {
            // Mock DB: 1. Fetch user's current password hash, 2. Update user's password
            pool.query.mockResolvedValueOnce({ rows: [{ password: 'old_hashed_password', name: 'Test User', email: 'test@example.com' }] });
            pool.query.mockResolvedValueOnce({ rowCount: 1 });

            const res = await request(app)
                .post('/api/auth/change-password')
                .send({
                    currentPassword: 'oldSecurePassword123',
                    newPassword: 'newSecurePassword123'
                });

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Password has been successfully updated. Please log in again.');

            // Verify Redis cache invalidation was called with the correct user ID
            expect(redisClient.del).toHaveBeenCalledWith('user:1:token_version');
        });
    });
});