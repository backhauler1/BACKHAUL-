const express = require('express');
const router = express.Router();
const pool = require('./db');
const { mapboxBreaker } = require('./circuitBreaker');
const logger = require('./logger');

/**
 * @route   GET /api/health
 * @desc    Reports the health of the application and its critical dependencies.
 * @access  Public
 *
 * This endpoint checks the status of the database and any external service circuit breakers.
 * It returns a 200 OK if all systems are operational.
 * It returns a 503 Service Unavailable if any critical dependency is down.
 */
router.get('/health', async (req, res) => {
    const checks = {};
    let isHealthy = true;

    // 1. Database Check: Can we execute a simple query?
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

    // 2. Mapbox Circuit Breaker Check: Is the breaker open?
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
    res.status(httpStatusCode).json({ status: isHealthy ? 'ok' : 'error', timestamp: new Date().toISOString(), checks });
});

module.exports = router;