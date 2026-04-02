const express = require('express');
const pool = require('./db');
const { mapboxBreaker } = require('./circuitBreaker');
const logger = require('./logger');

const router = express.Router();

let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 10000; // 10 seconds

const getBreakerStatus = (breaker) => {
    if (breaker.closed) return 'closed';
    if (breaker.open) return 'open';
    if (breaker.halfOpen) return 'half-open';
    return 'unknown';
};

const runHealthChecks = async () => {
    const checks = {
        database: { status: 'down', error: null },
        mapbox_api: { status: getBreakerStatus(mapboxBreaker) },
    };

    let isOk = true;

    // 1. Check Database
    try {
        await pool.query('SELECT 1');
        checks.database.status = 'up';
    } catch (e) {
        isOk = false;
        checks.database.error = e.message;
        logger.error('Health check failed: Database connection error.', { error: e.message });
    }

    // 2. Check Mapbox Circuit Breaker
    if (checks.mapbox_api.status === 'open') {
        isOk = false;
        logger.warn('Health check degraded: Mapbox circuit breaker is open.');
    }

    const healthStatus = {
        status: isOk ? 'ok' : 'error',
        timestamp: new Date().toISOString(),
        checks,
    };

    // Update cache
    cache = healthStatus;
    cacheTime = Date.now();

    return healthStatus;
};

const healthCheckHandler = async (req, res) => {
    const now = Date.now();
    if (cache && (now - cacheTime < CACHE_DURATION)) {
        res.setHeader('X-Cache', 'HIT');
        const statusCode = cache.status === 'ok' ? 200 : 503;
        return res.status(statusCode).json(cache);
    }

    res.setHeader('X-Cache', 'MISS');
    const healthStatus = await runHealthChecks();
    const statusCode = healthStatus.status === 'ok' ? 200 : 503;
    return res.status(statusCode).json(healthStatus);
};

router.get(['/health', '/healthz'], healthCheckHandler);

module.exports = router;