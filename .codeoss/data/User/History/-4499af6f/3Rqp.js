const request = require('supertest');
const express = require('express');
const pool = require('./db');
const redisClient = require('./redis');
const { Readable } = require('stream');

// 1. Mock the Database
jest.mock('./db', () => ({
    query: jest.fn(),
}));

// 2. Mock the Redis Client
jest.mock('./redis', () => ({
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
    connect: jest.fn(),
}));

// 3. Mock AWS SDK S3Client
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(() => ({
        send: mockS3Send,
    })),
    GetObjectCommand: jest.fn((args) => ({ type: 'GetObject', args })),
}));

// 4. Mock other external dependencies found in loads.js
jest.mock('@mapbox/mapbox-sdk/services/geocoding', () => {
    return jest.fn(() => ({
        forwardGeocode: jest.fn().mockReturnThis(),
        send: jest.fn()
    }));
});

jest.mock('./email', () => jest.fn());

jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        req.user = { id: 1 };
        next();
    },
    authorize: () => (req, res, next) => next(),
}));

// 5. Set up the Express app for testing
const loadsRouter = require('./loads');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/loads', loadsRouter);

describe('Loads API - Redis Cache Fallback', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Suppress console.error during expected failure tests to keep the terminal clean
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should fall back to the database if Redis GET throws an error', async () => {
        // 1. Force the Redis client to simulate a failure
        redisClient.get.mockRejectedValueOnce(new Error('Redis connection timeout'));

        // 2. Mock the Database to return a valid response.
        // The /find route performs two queries: one for count, one for the data.
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // count query
            .mockResolvedValueOnce({ rows: [{ id: 101, title: 'Fallback Load' }] }); // data query

        // 3. Make the request to the endpoint
        const res = await request(app).post('/api/loads/find');

        // 4. Verify the response is successful despite the Redis failure
        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual([{ id: 101, title: 'Fallback Load' }]);
        expect(res.body.pagination.totalItems).toBe(1);

        // 5. Verify the execution flow
        expect(redisClient.get).toHaveBeenCalledTimes(1); // It tried to use Redis
        expect(pool.query).toHaveBeenCalledTimes(2); // It successfully fell back to the DB
    });

    it('should call Redis setEx to cache the database results after a successful fallback', async () => {
        // 1. Simulate a cache miss (Redis returns null)
        redisClient.get.mockResolvedValueOnce(null);

        // 2. Mock the Database to return a valid response.
        const mockDbData = [{ id: 102, title: 'New Load' }];
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // count query
            .mockResolvedValueOnce({ rows: mockDbData }); // data query

        // 3. Make the request to the endpoint
        const res = await request(app).post('/api/loads/find');

        // 4. Verify the response is successful
        expect(res.statusCode).toBe(200);

        // 5. Verify that setEx was called with the correct arguments
        const expectedCacheKey = 'loads:find:page:1:limit:10:start:none:end:none:origin:none:dest:none';
        const expectedPayload = JSON.stringify({
            data: mockDbData,
            pagination: { currentPage: 1, totalPages: 1, totalItems: 1 }
        });

        expect(redisClient.setEx).toHaveBeenCalledTimes(1);
        expect(redisClient.setEx).toHaveBeenCalledWith(expectedCacheKey, 60, expectedPayload);
    });

    it('should return cached data from Redis and not query the database', async () => {
        // 1. Mock Redis to return a valid JSON string (Cache Hit)
        const cachedPayload = {
            data: [{ id: 99, title: 'Cached Load' }],
            pagination: { currentPage: 1, totalPages: 1, totalItems: 1 }
        };
        redisClient.get.mockResolvedValueOnce(JSON.stringify(cachedPayload));

        // 2. Make the request to the endpoint
        const res = await request(app).post('/api/loads/find');

        // 3. Verify the response matches the cache exactly
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(cachedPayload);

        // 4. Verify execution flow: Redis was queried, but DB and setEx were skipped
        expect(redisClient.get).toHaveBeenCalledTimes(1);
        expect(pool.query).not.toHaveBeenCalled();
        expect(redisClient.setEx).not.toHaveBeenCalled(); // It shouldn't try to save existing data
    });

    it('should handle database errors gracefully and return a 500 status code', async () => {
        // 1. Simulate a cache miss so it attempts to query the database
        redisClient.get.mockResolvedValueOnce(null);

        // 2. Force the database pool to throw an error
        pool.query.mockRejectedValueOnce(new Error('Database connection failed'));

        // 3. Make the request to the endpoint
        const res = await request(app).post('/api/loads/find');

        // 4. Verify the application caught the error and responded appropriately
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('Internal server error while searching for loads.');

        // 5. Verify the execution flow
        expect(pool.query).toHaveBeenCalledTimes(1);
    });
});

describe('Loads API - BOL Download', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should securely stream the BOL document to the assigned driver', async () => {
        // 1. Mock the DB to return a load where driver_id matches the logged-in user (id: 1)
        const mockLoad = {
            owner_id: 2,
            driver_id: 1, // User ID from the mock `protect` middleware
            bol_url: 'https://my-bucket.s3.amazonaws.com/loads/bols/bol-mock123.pdf',
            title: 'Test Load'
        };
        pool.query.mockResolvedValueOnce({ rows: [mockLoad] });

        // 2. Mock S3 send to return a simulated readable stream
        mockS3Send.mockResolvedValueOnce({
            ContentType: 'application/pdf',
            Body: Readable.from(['mock pdf content']),
        });

        // 3. Request the file, asking Supertest to parse it as a raw buffer (blob)
        const res = await request(app)
            .get('/api/loads/10/bol')
            .responseType('blob');

        // 4. Verify successful response and proper headers
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        expect(res.headers['content-disposition']).toBe('attachment; filename="BOL_test_load.pdf"');
        
        // 5. Verify the stream contents were piped correctly to the client
        expect(res.body.toString()).toBe('mock pdf content');

        // 6. Verify the S3 GetObjectCommand was configured with the correct file path
        expect(mockS3Send).toHaveBeenCalledTimes(1);
        const s3CallArg = mockS3Send.mock.calls[0][0];
        expect(s3CallArg.type).toBe('GetObject');
        expect(s3CallArg.args.Key).toBe('loads/bols/bol-mock123.pdf');
    });

    it('should return 403 if the user is neither the owner nor the driver', async () => {
        const mockLoad = { owner_id: 2, driver_id: 3, bol_url: 'https://test.com/mock.pdf', title: 'Test Load' };
        pool.query.mockResolvedValueOnce({ rows: [mockLoad] });
        
        const res = await request(app).get('/api/loads/10/bol');
        
        expect(res.statusCode).toBe(403);
        expect(mockS3Send).not.toHaveBeenCalled(); // Ensure the file wasn't fetched
    });

    it('should return 404 if the load does not have a BOL attached', async () => {
        const mockLoad = { owner_id: 1, driver_id: 2, bol_url: null, title: 'Test Load' };
        pool.query.mockResolvedValueOnce({ rows: [mockLoad] });
        
        const res = await request(app).get('/api/loads/10/bol');
        
        expect(res.statusCode).toBe(404);
        expect(mockS3Send).not.toHaveBeenCalled();
    });
});