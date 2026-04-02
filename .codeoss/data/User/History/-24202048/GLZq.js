const request = require('supertest');
const express = require('express');
const pool = require('./db');
const nodemailer = require('nodemailer');

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
jest.mock('./middleware/rateLimiter', () => ({
    authLimiter: (req, res, next) => next(),
}));
jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        req.user = { id: 1 };
        next();
    },
}));

// 4. Mock Nodemailer
const mockSendMail = jest.fn().mockResolvedValue(true);
jest.mock('nodemailer', () => ({
    createTransport: jest.fn(() => ({
        sendMail: mockSendMail,
    })),
}));

const passwordResetRouter = require('./passwordReset');
const app = express();
app.use(express.json());
app.use('/api/auth', passwordResetRouter);

describe('Password Reset API - Email Notifications', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should generate a token and send a reset email when the user exists', async () => {
        // Mock DB: 1. Find user by email, 2. Update user with reset token
        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Test User' }] });
        pool.query.mockResolvedValueOnce({ rowCount: 1 });

        const res = await request(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'test@example.com' });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('If an account with that email exists, we have sent a password reset link.');

        // Assert that nodemailer's sendMail was called with the correct details
        expect(mockSendMail).toHaveBeenCalledTimes(1);
        const mailOptions = mockSendMail.mock.calls[0][0];
        expect(mailOptions.to).toBe('test@example.com');
        expect(mailOptions.subject).toBe('Password Reset Request');
        expect(mailOptions.text).toContain('Hi Test User');
        expect(mailOptions.html).toContain('reset-password?token=');
    });
});