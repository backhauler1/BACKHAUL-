const express = require('express');
const router = express.Router();
const pool = require('./db');
const { mapboxBreaker } = require('./circuitBreaker');
const logger = require('./logger');

// --- In-memory cache for the health status ---
let cachedHealthStatus = null;
let lastCheckedTimestamp = 0;
const CACHE_DURATION_MS = 10000; // Cache for 10 seconds

/**
 * @route   GET /api/health
 * @desc    Reports the health of the application and its critical dependencies.
 * @access  Public
 *
 * This endpoint checks the status of the database and any external service circuit breakers.
 * It returns a 200 OK if all systems are operational.
 * It returns a 503 Service Unavailable if any critical dependency is down.
 * The result is cached for 10 seconds to prevent spamming.
 */
router.get('/health', async (req, res) => {
    // 1. Check if a valid cached response exists
    if (cachedHealthStatus && (Date.now() - lastCheckedTimestamp < CACHE_DURATION_MS)) {
        // Add a header to indicate the response is from cache
        res.setHeader('X-Cache', 'HIT');
        return res.status(cachedHealthStatus.httpStatusCode).json(cachedHealthStatus.payload);
    }

    const checks = {};
    let isHealthy = true;

    // 2. Database Check: Can we execute a simple query?
    try {
        await pool.query('SELECT 1');
        checks.database = {
            status: 'up',
            message: 'Database connection successful.'
        };
    } catch (error) {
        isHealthy = false;
        checks.database = {
            status: 'down',
            message: 'Failed to connect to the database.',
            error: error.message
        };
        logger.error('Health Check Error: Database connection failed.', { error: error.message });
    }

    // 3. Mapbox Circuit Breaker Check: Is the breaker open?
    try {
        let status = 'unknown';
        if (mapboxBreaker.closed) status = 'closed'; // Healthy: The circuit is closed and calls are flowing.
        if (mapboxBreaker.halfOpen) status = 'half-open'; // Degrading: The circuit is testing the service.
        if (mapboxBreaker.open) status = 'open'; // Unhealthy: The circuit is open, blocking calls.

        checks.mapbox_api = {
            status: status,
            message: `Mapbox circuit breaker is ${status}.`
        };

        // An open breaker means the service is considered unavailable.
        if (status === 'open') {
            isHealthy = false;
        }
    } catch (error) {
        isHealthy = false;
        checks.mapbox_api = { status: 'error', message: 'Failed to check Mapbox circuit breaker status.', error: error.message };
        logger.error('Health Check Error: Could not read circuit breaker status.', { error: error.message });
    }

    const httpStatusCode = isHealthy ? 200 : 503;
    const payload = { status: isHealthy ? 'ok' : 'error', timestamp: new Date().toISOString(), checks };

    // 4. Cache the new result
    cachedHealthStatus = { httpStatusCode, payload };
    lastCheckedTimestamp = Date.now();

    res.setHeader('X-Cache', 'MISS');
    res.status(httpStatusCode).json(payload);
});

module.exports = router;