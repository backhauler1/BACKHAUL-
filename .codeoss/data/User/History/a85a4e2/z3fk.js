const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');

// Note: If this file is inside a "middleware" folder, change the path to '../redis'
const redisClient = require('./redis');

/**
 * Rate limiter for sensitive authentication actions like login, refresh, password reset.
 * It limits each IP to a small number of requests in a time window to prevent brute-force attacks.
 */
const authLimiter = rateLimit({
	store: new RedisStore({
		sendCommand: (...args) => redisClient.sendCommand(args),
	}),
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 10, // Limit each IP to 10 requests per `window` (here, per 15 minutes)
	standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
	message: { message: 'Too many authentication attempts from this IP, please try again after 15 minutes.' },
});

/**
 * A more general rate limiter for all other API requests to prevent general DoS.
 */
const apiLimiter = rateLimit({
	store: new RedisStore({
		sendCommand: (...args) => redisClient.sendCommand(args),
	}),
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 100, // Limit each IP to 100 requests per `window`
	standardHeaders: true,
	legacyHeaders: false,
});

module.exports = {
	authLimiter,
	apiLimiter,
};