const request = require('supertest');
const express = require('express');
const pool = require('./db');
const redisClient = require('./redis');

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

// 3. Mock other external dependencies found in loads.js
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

// 4. Set up the Express app for testing
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
});