const request = require('supertest');
const express = require('express');
const pool = require('./db');
const { mapboxBreaker } = require('./circuitBreaker');

// Mock dependencies
jest.mock('./db', () => ({
    query: jest.fn(),
}));

jest.mock('./circuitBreaker', () => ({
    mapboxBreaker: {
        closed: true,
        open: false,
        halfOpen: false,
    },
}));

jest.mock('./logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const healthRouter = require('./health');
const app = express();
app.use('/api', healthRouter);

describe('GET /api/health', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset breaker to a healthy state before each test
        mapboxBreaker.closed = true;
        mapboxBreaker.open = false;
        mapboxBreaker.halfOpen = false;
    });

    it('should return 200 OK when all services are healthy', async () => {
        pool.query.mockResolvedValueOnce({}); // DB is healthy

        const res = await request(app).get('/api/health');

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.checks.database.status).toBe('up');
        expect(res.body.checks.mapbox_api.status).toBe('closed');
    });

    it('should return 503 Service Unavailable if the database is down', async () => {
        pool.query.mockRejectedValueOnce(new Error('Connection refused')); // DB is unhealthy

        const res = await request(app).get('/api/health');

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('error');
        expect(res.body.checks.database.status).toBe('down');
        expect(res.body.checks.database.error).toBe('Connection refused');
        expect(res.body.checks.mapbox_api.status).toBe('closed'); // Breaker is still healthy
    });

    it('should return 503 Service Unavailable if the Mapbox circuit breaker is open', async () => {
        pool.query.mockResolvedValueOnce({}); // DB is healthy
        mapboxBreaker.closed = false;
        mapboxBreaker.open = true; // Breaker is unhealthy

        const res = await request(app).get('/api/health');

        expect(res.statusCode).toBe(503);
        expect(res.body.status).toBe('error');
        expect(res.body.checks.database.status).toBe('up');
        expect(res.body.checks.mapbox_api.status).toBe('open');
    });

    it('should return 200 OK if the Mapbox circuit breaker is half-open (degraded but not fully down)', async () => {
        pool.query.mockResolvedValueOnce({}); // DB is healthy
        mapboxBreaker.closed = false;
        mapboxBreaker.halfOpen = true; // Breaker is degraded

        const res = await request(app).get('/api/health');

        expect(res.statusCode).toBe(200); // Still OK, but the status shows it's half-open
        expect(res.body.status).toBe('ok');
        expect(res.body.checks.mapbox_api.status).toBe('half-open');
    });
});
