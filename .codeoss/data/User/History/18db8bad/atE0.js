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
    hash: jest.fn(),
}));
jest.mock('jsonwebtoken', () => ({
    sign: jest.fn(),
    verify: jest.fn(),
}));
jest.mock('./rateLimiter', () => ({
    authLimiter: (req, res, next) => next(),
}));
jest.mock('./email', () => jest.fn().mockResolvedValue(true));
jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        req.user = { id: 1 };
        next();
    },
}));
jest.mock('./redis', () => ({
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
}));
jest.mock('@simplewebauthn/server', () => ({
    generateRegistrationOptions: jest.fn(),
    verifyRegistrationResponse: jest.fn(),
    generateAuthenticationOptions: jest.fn(),
    verifyAuthenticationResponse: jest.fn(),
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
        const mockUser = { id: 1, email: 'test@example.com', password: 'hashedpassword', roles: ['user'], token_version: 0, referral_code: 'REF123' };
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
        expect(res.body.user).toEqual({ id: 1, email: 'test@example.com', roles: ['user'], referralCode: 'REF123' });

        // Verify cookie headers
        const setCookieHeaders = res.headers['set-cookie'];
        expect(setCookieHeaders).toBeDefined();
        expect(setCookieHeaders.some(cookie => cookie.includes('token=mocked_access_token'))).toBe(true);
        expect(setCookieHeaders.some(cookie => cookie.includes('refreshToken=mocked_refresh_token'))).toBe(true);
        
        // Verify database refresh token update
        expect(pool.query).toHaveBeenCalledWith(
            'UPDATE users SET refresh_token = $1, last_login_at = NOW(), deletion_warning_sent = false WHERE id = $2',
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

describe('POST /api/auth/forgot-password', () => {
    const sendEmail = require('./email');

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.JWT_SECRET = 'test-secret';
    });

    it('should send a reset email if the user exists', async () => {
        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'test@example.com', password: 'hashedpassword' }] });
        jwt.sign.mockReturnValueOnce('mocked_reset_token');

        const res = await request(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'test@example.com' });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toContain('password reset link has been sent');
        expect(sendEmail).toHaveBeenCalledTimes(1);
        
        const emailArgs = sendEmail.mock.calls[0][0];
        expect(emailArgs.to).toBe('test@example.com');
        expect(emailArgs.text).toContain('mocked_reset_token');
    });

    it('should return a generic success message even if the user does not exist', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }); // User not found

        const res = await request(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'nonexistent@example.com' });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toContain('password reset link has been sent');
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

describe('POST /api/auth/reset-password', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.JWT_SECRET = 'test-secret';
    });

    it('should successfully reset the password with a valid token', async () => {
        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, password: 'oldhash' }] });
        jwt.verify.mockReturnValueOnce({ id: 1, email: 'test@example.com' });
        bcrypt.hash.mockResolvedValueOnce('newhashedpassword');
        pool.query.mockResolvedValueOnce({ rowCount: 1 }); // Update query

        const res = await request(app)
            .post('/api/auth/reset-password')
            .send({ id: 1, token: 'valid_token', newPassword: 'newpassword123' });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Password has been successfully reset. You can now log in with your new password.');
        expect(pool.query).toHaveBeenCalledWith(
            'UPDATE users SET password = $1, refresh_token = NULL WHERE id = $2',
            ['newhashedpassword', 1]
        );
    });

    it('should return 400 if the token is invalid or expired', async () => {
        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, password: 'oldhash' }] });
        jwt.verify.mockImplementationOnce(() => { throw new Error('Token expired'); });

        const res = await request(app)
            .post('/api/auth/reset-password')
            .send({ id: 1, token: 'invalid_token', newPassword: 'newpassword123' });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Invalid or expired reset token.');
        expect(bcrypt.hash).not.toHaveBeenCalled();
    });

    it('should return 400 if the new password is too short', async () => {
        const res = await request(app)
            .post('/api/auth/reset-password')
            .send({ id: 1, token: 'sometoken', newPassword: 'short' });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Password must be at least 8 characters long.');
    });
});

describe('POST /api/auth/send-otp', () => {
    const sendEmail = require('./email');
    const redisClient = require('./redis');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should generate an OTP, store it in Redis, and send an email', async () => {
        pool.query.mockResolvedValueOnce({ rows: [{ email: 'test@example.com', name: 'Test User' }] });

        const res = await request(app).post('/api/auth/send-otp');

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Verification PIN sent to your email.');
        expect(redisClient.setEx).toHaveBeenCalledWith(
            'user:1:otp',
            600,
            expect.stringMatching(/^\d{6}$/)
        );
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0].to).toBe('test@example.com');
        expect(sendEmail.mock.calls[0][0].text).toMatch(/Your Verification PIN is: \d{6}/);
    });

    it('should return 404 if the user is not found in the database', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app).post('/api/auth/send-otp');

        expect(res.statusCode).toBe(404);
        expect(res.body.message).toBe('User not found.');
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

describe('POST /api/auth/verify-otp', () => {
    const redisClient = require('./redis');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should successfully verify the OTP, delete it, and set the verified flag', async () => {
        redisClient.get.mockResolvedValueOnce('123456');

        const res = await request(app)
            .post('/api/auth/verify-otp')
            .send({ pin: '123456' });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Identity verified successfully.');
        expect(redisClient.del).toHaveBeenCalledWith('user:1:otp');
        expect(redisClient.setEx).toHaveBeenCalledWith('user:1:verified', 900, 'true');
    });

    it('should return 401 if the PIN is incorrect', async () => {
        redisClient.get.mockResolvedValueOnce('123456');

        const res = await request(app)
            .post('/api/auth/verify-otp')
            .send({ pin: '654321' });

        expect(res.statusCode).toBe(401);
        expect(res.body.message).toBe('Invalid PIN. Please try again.');
        expect(redisClient.del).not.toHaveBeenCalled();
    });

    it('should return 400 if the PIN has expired or was not requested', async () => {
        redisClient.get.mockResolvedValueOnce(null);

        const res = await request(app)
            .post('/api/auth/verify-otp')
            .send({ pin: '123456' });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('PIN has expired or was not requested.');
    });
});

describe('WebAuthn Passkey Routes', () => {
    const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');
    const redisClient = require('./redis');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/auth/webauthn/register/generate-options', () => {
        it('should generate options and cache the challenge in Redis', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ email: 'test@example.com', name: 'Test' }] });
            pool.query.mockResolvedValueOnce({ rows: [] }); // No existing passkeys
            generateRegistrationOptions.mockResolvedValueOnce({ challenge: 'mock_challenge' });

            const res = await request(app).get('/api/auth/webauthn/register/generate-options');

            expect(res.statusCode).toBe(200);
            expect(redisClient.setEx).toHaveBeenCalledWith('user:1:webauthn_challenge', 300, 'mock_challenge');
        });
    });

    describe('POST /api/auth/webauthn/register/verify', () => {
        it('should verify response, insert passkey, and clear cache', async () => {
            redisClient.get.mockResolvedValueOnce('mock_challenge');
            verifyRegistrationResponse.mockResolvedValueOnce({
                verified: true,
                registrationInfo: {
                    credentialID: new Uint8Array([1, 2, 3]),
                    credentialPublicKey: new Uint8Array([4, 5, 6]),
                    counter: 0,
                    credentialDeviceType: 'singleDevice',
                    credentialBackedUp: false
                }
            });
            pool.query.mockResolvedValueOnce({ rowCount: 1 }); // Insert passkey

            const res = await request(app)
                .post('/api/auth/webauthn/register/verify')
                .send({ response: { transports: ['internal'] } });

            expect(res.statusCode).toBe(200);
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO passkeys'), expect.any(Array));
            expect(redisClient.del).toHaveBeenCalledWith('user:1:webauthn_challenge');
        });
    });

    describe('POST /api/auth/webauthn/login/generate-options', () => {
        it('should return 404 if email is not found', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] });
            
            const res = await request(app)
                .post('/api/auth/webauthn/login/generate-options')
                .send({ email: 'nonexistent@example.com' });
                
            expect(res.statusCode).toBe(404);
        });
    });

    describe('POST /api/auth/webauthn/login/verify', () => {
        it('should successfully login and issue tokens if passkey validates', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'test@example.com' }] }); // Find user
            redisClient.get.mockResolvedValueOnce('mock_challenge'); // Challenge cached
            pool.query.mockResolvedValueOnce({ rows: [{ id: 10, credential_id: 'base64str', public_key: 'base64str' }] }); // Find passkey
            
            verifyAuthenticationResponse.mockResolvedValueOnce({
                verified: true,
                authenticationInfo: { newCounter: 5 }
            });
            
            pool.query.mockResolvedValueOnce({ rowCount: 1 }); // Update counter
            pool.query.mockResolvedValueOnce({ rowCount: 1 }); // Update refresh token

            const res = await request(app)
                .post('/api/auth/webauthn/login/verify')
                .send({ email: 'test@example.com', response: { id: 'base64str' } });

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Logged in successfully with Passkey.');
            expect(res.headers['set-cookie']).toBeDefined();
        });
    });
});