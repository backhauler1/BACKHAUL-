const request = require('supertest');

// 1. Set environment variables before any modules are loaded
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_UPLOAD_MAX = '5'; // Ensure the limit is explicitly set for the test
process.env.AWS_S3_BUCKET_NAME = 'test-bucket'; // Satisfies multer validation checks

// 2. Mock the Database to prevent actual inserts during the test
jest.mock('./db', () => ({
    query: jest.fn().mockResolvedValue({ rows: [{ id: 1, name: 'Test Company' }] }),
}));

// Mock Sentry as it's a dependency of server.js but not needed for this test
jest.mock('@sentry/node', () => ({ init: jest.fn(), Handlers: { requestHandler: () => (req, res, next) => next(), errorHandler: () => (err, req, res, next) => res.end() } }));

// 3. Mock Authentication and Authorization to allow our test requests through
jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        req.user = { id: 1, roles: ['admin'] };
        next();
    },
    authorize: () => (req, res, next) => next(),
    requireVerification: (req, res, next) => next(),
}));

// 4. Mock CSRF validation to bypass the security check for automated testing
jest.mock('./csrf', () => ({
    validateCsrf: (req, res, next) => next(),
    generateCsrfToken: (req, res) => res.status(200).json({ csrfToken: 'test' })
}));

// 5. Mock geocoding service to prevent Mapbox init errors from dependency chain
jest.mock('./geocodingService', () => ({
    geocodeAddress: jest.fn(),
}));

jest.mock('./i18nBackend', () => ({
    i18next: {},
    middleware: { handle: () => (req, res, next) => next() }
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

// Mock multer-s3
jest.mock('multer-s3', () => jest.fn(() => 'mock-s3-storage'));

jest.mock('./s3');

// 6. Mock Multer to track if it actually executes
let mockMulterMiddleware;
jest.mock('multer', () => {
    const actualMulter = jest.requireActual('multer');
    // Define the mock function here so it's in scope for the factory and can be cleared in beforeEach
    mockMulterMiddleware = jest.fn((req, res, next) => {
        req.multerExecuted = true;
        next();
    });
    const multerWrapper = () => ({
        single: () => mockMulterMiddleware,
        none: () => mockMulterMiddleware
    });
    multerWrapper.diskStorage = actualMulter.diskStorage;
    multerWrapper.MulterError = actualMulter.MulterError;
    return multerWrapper;
});

jest.mock('./uploads', () => ({
    uploadThumbnail: { single: () => mockMulterMiddleware },
    uploadDocument: { single: () => mockMulterMiddleware },
    uploadSignedBol: { single: () => mockMulterMiddleware }
}), { virtual: true });

// Import the app AFTER all mocks are defined
const app = require('./server');

describe('Upload Rate Limiter', () => {
    beforeEach(() => {
        // Reset the mock's call count before each test
        if (mockMulterMiddleware) mockMulterMiddleware.mockClear();
    });

    it('should bypass multer and return 429 when the upload limit is exceeded', async () => {
        // Send 5 successful requests (the maximum allowed)
        for (let i = 0; i < 5; i++) {
            const res = await request(app).post('/api/companies/register').send({ companyName: 'Test' });
            expect(res.statusCode).toBe(201);
        }
        expect(mockMulterMiddleware).toHaveBeenCalledTimes(5);

        // Send the 6th request, which should hit the rate limit before multer ever executes
        const blockedRes = await request(app).post('/api/companies/register').send({ companyName: 'Test' });
        expect(blockedRes.statusCode).toBe(429);
        expect(blockedRes.body.message).toBe('Too many file uploads from this IP, please try again after an hour.');
        
        // CRITICAL CHECK: Ensure Multer was NOT called on the 6th request!
        expect(mockMulterMiddleware).toHaveBeenCalledTimes(5); 
    });
});