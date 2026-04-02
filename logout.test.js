const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const pool = require('./db');
const logoutRouter = require('./logout');

// Mock dependencies
jest.mock('./db', () => ({
    query: jest.fn(),
}));

const app = express();
app.use(cookieParser()); // Use cookie-parser to handle req.cookies
app.use(express.json());
app.use('/api/auth', logoutRouter);

describe('POST /api/auth/logout', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Set NODE_ENV to production to test secure cookie attributes
        process.env.NODE_ENV = 'production';
    });

    afterEach(() => {
        // Reset NODE_ENV after tests
        process.env.NODE_ENV = 'test';
    });

    it('should clear cookies and invalidate the refresh token in the database', async () => {
        pool.query.mockResolvedValueOnce({ rowCount: 1 }); // Mock DB update

        const res = await request(app)
            .post('/api/auth/logout')
            .set('Cookie', ['refreshToken=some_valid_token']);

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Logged out successfully.');

        // Verify cookies are cleared by setting them to an empty value with a past expiry
        const setCookieHeaders = res.headers['set-cookie'];
        expect(setCookieHeaders).toBeDefined();
        expect(setCookieHeaders.some(cookie => cookie.startsWith('token=;'))).toBe(true);
        expect(setCookieHeaders.some(cookie => cookie.startsWith('refreshToken=;'))).toBe(true);
        
        // Verify the secure attributes are set correctly
        expect(setCookieHeaders[0]).toContain('HttpOnly');
        expect(setCookieHeaders[0]).toContain('Secure');
        expect(setCookieHeaders[0]).toContain('SameSite=Strict');

        // Verify the DB call to invalidate the token
        expect(pool.query).toHaveBeenCalledWith(
            'UPDATE users SET refresh_token = NULL WHERE refresh_token = $1',
            ['some_valid_token']
        );
    });

    it('should not query the database if no refresh token cookie is present', async () => {
        const res = await request(app).post('/api/auth/logout'); // No cookie set

        expect(res.statusCode).toBe(200);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('should clear cookies even if the database query fails', async () => {
        pool.query.mockRejectedValueOnce(new Error('DB connection lost'));
        jest.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console error

        const res = await request(app).post('/api/auth/logout').set('Cookie', ['refreshToken=some_token']);

        expect(res.statusCode).toBe(200);
        expect(res.headers['set-cookie']).toBeDefined(); // Cookies should still be cleared
        expect(pool.query).toHaveBeenCalledTimes(1);
    });
});