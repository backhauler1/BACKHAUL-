const request = require('supertest');
const express = require('express');
// We need to get the original modules to mock them before they are required by the router
const pool = require('./db');
const { mapboxBreaker } = require('./circuitBreaker');
const logger = require('./logger');

// Mock dependencies
jest.mock('./db');
jest.mock('./circuitBreaker');
jest.mock('./logger');

describe('GET /api/health', () => {
    let app;

    beforeEach(() => {
        jest.resetModules(); // This is key to resetting the in-memory cache in health.js

        // Re-require the router inside beforeEach to get a fresh instance with a cleared cache
        const healthRouter = require('./health');

        const expressApp = express();
        expressApp.use('/api', healthRouter);
        app = expressApp;

        jest.clearAllMocks();
        // Reset breaker to a healthy state before each test
        mapboxBreaker.closed = true;
        mapboxBreaker.open = false;
        mapboxBreaker.halfOpen = false;
    });

    it('should return 200 OK when all services are healthy', async () => {
        pool.query.mockResolvedValueOnce({}); // DB is healthy

        const res = await request(app).get('/api/health');
        const res = await request(app).get('/api/healthz');

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.checks.database.status).toBe('up');
        expect(res.body.checks.mapbox_api.status).toBe('closed');
        expect(res.headers['x-cache']).toBe('MISS');
    });

    it('should return 503 Service Unavailable if the database is down', async () => {
        pool.query.mockRejectedValueOnce(new Error('Connection refused')); // DB is unhealthy

        const res = await request(app).get('/api/health');
        const res = await request(app).get('/api/healthz');

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('error');
        expect(res.body.checks.database.status).toBe('down');
        expect(res.body.checks.database.error).toBe('Connection refused');
        expect(res.body.checks.mapbox_api.status).toBe('closed'); // Breaker is still healthy
        expect(res.headers['x-cache']).toBe('MISS');
    });

    it('should return 503 Service Unavailable if the Mapbox circuit breaker is open', async () => {
        pool.query.mockResolvedValueOnce({}); // DB is healthy
        mapboxBreaker.closed = false;
        mapboxBreaker.open = true; // Breaker is unhealthy

        const res = await request(app).get('/api/health');
        const res = await request(app).get('/api/healthz');

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('error');
        expect(res.body.checks.database.status).toBe('up');
        expect(res.body.checks.mapbox_api.status).toBe('open');
        expect(res.headers['x-cache']).toBe('MISS');
    });

    it('should return 200 OK if the Mapbox circuit breaker is half-open (degraded but not fully down)', async () => {
        pool.query.mockResolvedValueOnce({}); // DB is healthy
        mapboxBreaker.closed = false;
        mapboxBreaker.halfOpen = true; // Breaker is degraded

        const res = await request(app).get('/api/health');
        const res = await request(app).get('/api/healthz');

        expect(res.statusCode).toBe(200); // Still OK, but the status shows it's half-open
        expect(res.body.status).toBe('ok');
        expect(res.body.checks.mapbox_api.status).toBe('half-open');
    });

    describe('Caching Logic', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should cache the health status and return a HIT on subsequent requests', async () => {
            pool.query.mockResolvedValue({}); // DB is healthy

            // 1. First request should be a MISS
            const res1 = await request(app).get('/api/health');
            expect(res1.statusCode).toBe(200);
            expect(res1.headers['x-cache']).toBe('MISS');
            expect(pool.query).toHaveBeenCalledTimes(1);

            // 2. Second request immediately after should be a HIT
            const res2 = await request(app).get('/api/health');
            expect(res2.statusCode).toBe(200);
            expect(res2.headers['x-cache']).toBe('HIT');
            // The DB query should NOT have been called again
            expect(pool.query).toHaveBeenCalledTimes(1);
            expect(res2.body.timestamp).toBe(res1.body.timestamp); // Timestamps should match

            // 3. Advance time past the cache duration (10 seconds)
            jest.advanceTimersByTime(11000);

            // 4. Third request should be a MISS again
            const res3 = await request(app).get('/api/health');
            const res3 = await request(app).get('/api/healthz');
            expect(res3.statusCode).toBe(200);
            expect(res3.headers['x-cache']).toBe('MISS');
            // The DB query should have been called again
            expect(pool.query).toHaveBeenCalledTimes(2);
            expect(res3.body.timestamp).not.toBe(res1.body.timestamp);
        });

        it('should cache a failure status (503) as well', async () => {
            pool.query.mockRejectedValue(new Error('DB is down'));

            // 1. First request is a MISS and fails
            const res1 = await request(app).get('/api/health');
            expect(res1.statusCode).toBe(503);
            expect(res1.headers['x-cache']).toBe('MISS');
            expect(pool.query).toHaveBeenCalledTimes(1);

            // 2. Second request is a HIT and also fails (with the cached result)
            const res2 = await request(app).get('/api/health');
            expect(res2.statusCode).toBe(503);
            expect(res2.headers['x-cache']).toBe('HIT');
            expect(pool.query).toHaveBeenCalledTimes(1); // Not called again
        });
    });
});