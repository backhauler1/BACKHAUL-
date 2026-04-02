const request = require('supertest');

// 1. Set environment variables before any modules are loaded
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_UPLOAD_MAX = '5'; // Ensure the limit is explicitly set for the test

// 2. Mock the Database to prevent actual inserts during the test
jest.mock('./db', () => ({
    query: jest.fn().mockResolvedValue({ rows: [{ id: 1, name: 'Test Company' }] }),
}));

// 3. Mock Authentication and Authorization to allow our test requests through
jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        req.user = { id: 1, roles: ['admin'] };
        next();
    },
    authorize: () => (req, res, next) => next(),
}));

// 4. Mock CSRF validation to bypass the security check for automated testing
jest.mock('./csrf', () => ({
    validateCsrf: (req, res, next) => next(),
    generateCsrfToken: (req, res) => res.status(200).json({ csrfToken: 'test' })
}));

// 5. Mock Redis to use a simple memory store so the rate limiter works without a real server
jest.mock('rate-limit-redis', () => ({
    RedisStore: class MockStore {
        constructor() { this.hits = {}; }
        async increment(key) {
            this.hits[key] = (this.hits[key] || 0) + 1;
            return { totalHits: this.hits[key], resetTime: new Date(Date.now() + 3600000) };
        }
        async decrement(key) { this.hits[key] = Math.max(0, (this.hits[key] || 0) - 1); }
        async resetKey(key) { delete this.hits[key]; }
    }
}));
jest.mock('./redis', () => ({
    sendCommand: jest.fn(),
    connect: jest.fn(),
    on: jest.fn(),
}));

// 6. Mock Multer to track if it actually executes
const multerMock = jest.fn((req, res, next) => {
    req.multerExecuted = true;
    next();
});
jest.mock('multer', () => {
    const actualMulter = jest.requireActual('multer');
    const multerWrapper = () => ({
        single: () => multerMock // Return our mock middleware instead of the real one
    });
    multerWrapper.diskStorage = actualMulter.diskStorage;
    multerWrapper.MulterError = actualMulter.MulterError;
    return multerWrapper;
});

// Import the app AFTER all mocks are defined
const app = require('./server');

describe('Upload Rate Limiter', () => {
    it('should bypass multer and return 429 when the upload limit is exceeded', async () => {
        // Send 5 successful requests (the maximum allowed)
        for (let i = 0; i < 5; i++) {
            const res = await request(app).post('/api/companies/register').send({ companyName: 'Test' });
            expect(res.statusCode).toBe(201);
        }
        expect(multerMock).toHaveBeenCalledTimes(5);

        // Send the 6th request, which should hit the rate limit before multer ever executes
        const blockedRes = await request(app).post('/api/companies/register').send({ companyName: 'Test' });
        expect(blockedRes.statusCode).toBe(429);
        expect(blockedRes.body.message).toBe('Too many file uploads from this IP, please try again after an hour.');
        
        // CRITICAL CHECK: Ensure Multer was NOT called on the 6th request!
        expect(multerMock).toHaveBeenCalledTimes(5); 
    });
});