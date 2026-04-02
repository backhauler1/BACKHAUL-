const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const refreshRouter = require('./refresh');

// Mock dependencies
jest.mock('./db', () => ({
    query: jest.fn(),
}));

// We need to mock the callback-style usage of jwt.verify in refresh.js
jest.mock('jsonwebtoken', () => ({
    ...jest.requireActual('jsonwebtoken'), // Keep original sign, etc.
    verify: jest.fn(),
    sign: jest.fn(),
}));

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', refreshRouter);

describe('POST /api/auth/refresh', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Set NODE_ENV to production to test secure cookie attributes
        process.env.NODE_ENV = 'production';
        process.env.JWT_SECRET = 'test-secret';
        process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    });

    afterEach(() => {
        // Reset NODE_ENV after tests
        process.env.NODE_ENV = 'test';
    });

    it('should successfully issue a new access token for a valid refresh token', async () => {
        const mockRefreshToken = 'valid_refresh_token';
        const mockUser = { id: 1, roles: ['driver'], token_version: 0 };

        // 1. Mock DB to find the user by the refresh token
        pool.query.mockResolvedValueOnce({ rows: [mockUser] });

        // 2. Mock jwt.verify to successfully decode the refresh token
        jwt.verify.mockImplementation((token, secret, callback) => {
            callback(null, { id: mockUser.id }); // Simulate successful verification
        });

        // 3. Mock jwt.sign to generate the new access token
        jwt.sign.mockReturnValue('new_access_token');

        const res = await request(app)
            .post('/api/auth/refresh')
            .set('Cookie', [`refreshToken=${mockRefreshToken}`]);

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Access token refreshed successfully.');

        // Verify a new access token cookie was set with correct attributes
        const setCookieHeader = res.headers['set-cookie'][0];
        expect(setCookieHeader).toContain('token=new_access_token');
        expect(setCookieHeader).toContain('HttpOnly');
        expect(setCookieHeader).toContain('Secure');
        expect(setCookieHeader).toContain('SameSite=Strict');
        expect(setCookieHeader).toContain('Max-Age=900'); // 15 * 60

        // Verify the correct DB query was made
        expect(pool.query).toHaveBeenCalledWith('SELECT * FROM users WHERE refresh_token = $1', [mockRefreshToken]);
        
        // Verify jwt.sign was called to create the new access token
        expect(jwt.sign).toHaveBeenCalledWith(
            { id: mockUser.id, roles: mockUser.roles, tokenVersion: mockUser.token_version },
            'test-secret',
            { expiresIn: '15m' }
        );
    });

    it('should return 401 if no refresh token cookie is present', async () => {
        const res = await request(app).post('/api/auth/refresh'); // No cookie

        expect(res.statusCode).toBe(401);
        expect(res.body.message).toBe('Refresh token not found.');
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('should return 403 if the refresh token is not found in the database (e.g., after logout)', async () => {
        // Mock DB to find no user for the given token
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app)
            .post('/api/auth/refresh')
            .set('Cookie', ['refreshToken=invalid_or_revoked_token']);

        expect(res.statusCode).toBe(403);
        expect(res.body.message).toBe('Invalid refresh token.');
        expect(jwt.verify).not.toHaveBeenCalled();
    });

    it('should return 403 if the refresh token is expired or has an invalid signature', async () => {
        const mockUser = { id: 1, roles: ['driver'], token_version: 0 };
        pool.query.mockResolvedValueOnce({ rows: [mockUser] });

        // Mock jwt.verify to call the callback with an error
        jwt.verify.mockImplementation((token, secret, callback) => {
            callback(new Error('jwt expired'), null);
        });

        const res = await request(app)
            .post('/api/auth/refresh')
            .set('Cookie', ['refreshToken=expired_token']);

        expect(res.statusCode).toBe(403);
        expect(res.body.message).toBe('Refresh token is not valid.');
    });

    it('should return 500 if the database query fails', async () => {
        pool.query.mockRejectedValueOnce(new Error('DB connection error'));
        jest.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console error

        const res = await request(app)
            .post('/api/auth/refresh')
            .set('Cookie', ['refreshToken=some_token']);

        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('Internal server error.');
        expect(console.error).toHaveBeenCalledWith('Refresh Token Error:', expect.any(Error));
    });
});
