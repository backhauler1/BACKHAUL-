const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const loginRouter = require('./login');

// Mock dependencies
jest.mock('./db', () => ({
    query: jest.fn(),
}));
jest.mock('bcrypt', () => ({
    compare: jest.fn(),
}));
jest.mock('jsonwebtoken', () => ({
    sign: jest.fn(),
}));
jest.mock('./rateLimiter', () => ({
    authLimiter: (req, res, next) => next(),
}));

const app = express();
app.use(express.json());
app.use('/api/auth', loginRouter);

describe('POST /api/auth/login', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.JWT_SECRET = 'test-secret';
        process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    });

    it('should successfully log in and set cookies for valid credentials', async () => {
        // Mock DB and bcrypt
        const mockUser = { id: 1, email: 'test@example.com', password: 'hashedpassword', roles: ['user'], token_version: 0 };
        pool.query.mockResolvedValueOnce({ rows: [mockUser] });
        bcrypt.compare.mockResolvedValueOnce(true);
        
        // Mock JWT
        jwt.sign
            .mockReturnValueOnce('mocked_access_token') // For access token
            .mockReturnValueOnce('mocked_refresh_token'); // For refresh token

        // Mock DB UPDATE for refresh token
        pool.query.mockResolvedValueOnce({ rowCount: 1 });

        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'test@example.com', password: 'password123' });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Logged in successfully.');
        expect(res.body.user).toEqual({ id: 1, email: 'test@example.com', roles: ['user'] });

        // Verify cookie headers
        const setCookieHeaders = res.headers['set-cookie'];
        expect(setCookieHeaders).toBeDefined();
        expect(setCookieHeaders.some(cookie => cookie.includes('token=mocked_access_token'))).toBe(true);
        expect(setCookieHeaders.some(cookie => cookie.includes('refreshToken=mocked_refresh_token'))).toBe(true);
        
        // Verify database refresh token update
        expect(pool.query).toHaveBeenCalledWith(
            'UPDATE users SET refresh_token = $1 WHERE id = $2',
            ['mocked_refresh_token', 1]
        );
    });

    it('should return 401 for an invalid password', async () => {
        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'test@example.com', password: 'hashedpassword' }] });
        bcrypt.compare.mockResolvedValueOnce(false); // Password mismatch

        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'test@example.com', password: 'wrongpassword' });

        expect(res.statusCode).toBe(401);
        expect(res.body.message).toBe('Invalid credentials.');
    });

    it('should return 401 if the user is not found', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }); // User not found

        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'notfound@example.com', password: 'password123' });

        expect(res.statusCode).toBe(401);
        expect(res.body.message).toBe('Invalid credentials.');
    });

    it('should return 400 if email or password are missing', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'test@example.com' }); // Missing password

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Email and password are required.');
    });
});