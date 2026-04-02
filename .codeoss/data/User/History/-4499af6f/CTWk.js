const request = require('supertest');
const express = require('express');
const pool = require('./db');
const multer = require('multer');

// 1. Mock Database Interactions
jest.mock('./db', () => ({
    query: jest.fn(),
    connect: jest.fn(),
}));

// 2. Mock Authentication and Authorization Middleware
jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        // Mock an authenticated user with ID 1
        req.user = { id: 1, roles: ['user'] };
        next();
    },
    authorize: () => (req, res, next) => next(),
}));

// 3. Mock Redis, Email, and AWS S3
jest.mock('./redis', () => ({
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
}));
jest.mock('./email', () => jest.fn(() => Promise.resolve()));

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(() => ({ send: mockS3Send })),
    GetObjectCommand: jest.fn((args) => ({ type: 'GetObject', args })),
}));

// 4. Mock Multer and Multer-S3
jest.mock('multer-s3', () => jest.fn(() => 'mock-s3-storage'));
jest.mock('multer');
const mockSingle = jest.fn();
const mockNone = jest.fn(() => (req, res, next) => next());
multer.mockReturnValue({ 
    single: mockSingle,
    none: mockNone
});

// 5. Mock Mapbox Geocoding Service
const mockGeocodeSend = jest.fn();
jest.mock('@mapbox/mapbox-sdk/services/geocoding', () => jest.fn(() => ({
    forwardGeocode: jest.fn(() => ({
        send: mockGeocodeSend
    }))
})));

// Setup Express application for testing
const loadsRouter = require('./loads');
const app = express();
app.use(express.json()); // Parses JSON bodies sent by supertest
app.use(express.urlencoded({ extended: true }));
app.use('/api/loads', loadsRouter);

describe('Loads API - POST /post', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Suppress console output for expected error cases to keep tests clean
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Default setup: mock multer attaching a file unless a specific header is passed
        mockSingle.mockImplementation(() => (req, res, next) => {
            if (!req.headers['x-no-file']) {
                req.file = { location: 'https://mock-bucket.s3.amazonaws.com/loads/bols/mock-bol.pdf' };
            }
            next();
        });

        // Default setup: Mapbox successfully finds coordinates
        mockGeocodeSend.mockResolvedValue({
            body: { features: [{ center: [-74.0060, 40.7128] }] }
        });
    });

    it('should successfully post a new load and attach geocoded coordinates', async () => {
        // 1. Mock DB returning no suspended companies for the user
        pool.query.mockResolvedValueOnce({ rows: [] });
        
        // 2. Mock DB returning the newly inserted load
        const mockNewLoad = { id: 10, title: 'Test Machinery Load', pickup_lng: -74.0060, pickup_lat: 40.7128 };
        pool.query.mockResolvedValueOnce({ rows: [mockNewLoad] });

        const res = await request(app)
            .post('/api/loads/post')
            .send({
                title: 'Test Machinery Load',
                pickupAddress: 'New York, NY',
                deliveryAddress: 'Los Angeles, CA'
            });

        expect(res.statusCode).toBe(201);
        expect(res.body.message).toBe('Load posted successfully!');
        expect(res.body.data).toEqual(mockNewLoad);
        
        // Verify the suspension check query was executed first
        expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining('SELECT id FROM companies WHERE owner_id = $1 AND is_suspended = true LIMIT 1'), [1]);
        // Verify the insert query was executed second
        expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO loads'), expect.any(Array));
    });

    it('should return 403 if the user owns a suspended company', async () => {
        // Mock DB returning a suspended company record
        pool.query.mockResolvedValueOnce({ rows: [{ id: 5 }] }); 

        const res = await request(app)
            .post('/api/loads/post')
            .send({ title: 'Test Load', pickupAddress: 'NY', deliveryAddress: 'LA' });

        expect(res.statusCode).toBe(403);
        expect(res.body.message).toBe('Cannot post load: Your company account is suspended.');
        expect(pool.query).toHaveBeenCalledTimes(1); // Should halt before the insert
    });

    it('should return 400 if geocoding fails to find the pickup coordinates', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }); // User is not suspended
        
        // Mock Mapbox returning no features
        mockGeocodeSend.mockResolvedValueOnce({ body: { features: [] } });

        const res = await request(app)
            .post('/api/loads/post')
            .send({ title: 'Test Load', pickupAddress: 'Nowhere', deliveryAddress: 'LA' });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Could not find coordinates for the specified pickup address.');
    });
});

describe('Loads API - POST /find', () => {
    const redisClient = require('./redis');

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should return cached data from Redis if available', async () => {
        const mockCachedData = {
            data: [{ id: 1, title: 'Cached Load' }],
            pagination: { currentPage: 1, totalPages: 1, totalItems: 1 }
        };
        redisClient.get.mockResolvedValueOnce(JSON.stringify(mockCachedData));

        const res = await request(app)
            .post('/api/loads/find')
            .send({}); 

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(mockCachedData);
        expect(redisClient.get).toHaveBeenCalledTimes(1);
        expect(pool.query).not.toHaveBeenCalled(); // Should not hit the DB
    });

    it('should query the database, cache the result, and apply filters if cache misses', async () => {
        redisClient.get.mockResolvedValueOnce(null); // Cache miss

        const mockCountRows = [{ count: '1' }];
        const mockLoadRows = [{ id: 2, title: 'DB Load', pickup_date: '2023-10-25' }];

        pool.query.mockResolvedValueOnce({ rows: mockCountRows }); // COUNT query
        pool.query.mockResolvedValueOnce({ rows: mockLoadRows });  // SELECT query

        const res = await request(app)
            .post('/api/loads/find')
            .send({
                startDate: '2023-10-20',
                'backhaul-origin': 'Chicago'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual(mockLoadRows);
        
        // Verify DB was called with filters
        expect(pool.query).toHaveBeenCalledTimes(2);
        
        // Verify Redis SET was called
        expect(redisClient.setEx).toHaveBeenCalledTimes(1);
        expect(redisClient.setEx).toHaveBeenCalledWith(
            expect.stringContaining('loads:find:'),
            60,
            expect.any(String)
        );
    });

    it('should gracefully fall back to the database if Redis GET fails', async () => {
        redisClient.get.mockRejectedValueOnce(new Error('Redis connection lost'));

        pool.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app).post('/api/loads/find').send({});

        expect(res.statusCode).toBe(200);
        expect(pool.query).toHaveBeenCalledTimes(2); // Still queries DB
    });
});