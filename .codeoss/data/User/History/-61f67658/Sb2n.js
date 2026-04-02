const express = require('express');
const pool = require('./db');
const redisClient = require('./redis');
const logger = require('./logger');

const router = express.Router();

/**
 * GET /api/healthz
 * Health check endpoint used by load balancers and container orchestrators.
 */
router.get('/healthz', async (req, res) => {
    try {
        // Verify essential connections
        await pool.query('SELECT 1');
        await redisClient.ping();

        res.status(200).json({ status: 'ok', message: 'All dependencies are operational.' });
    } catch (error) {
        logger.error('Health check failed:', { error: error.message, stack: error.stack });
        res.status(503).json({ status: 'error', message: 'Service unavailable.' });
    }
});

module.exports = router;