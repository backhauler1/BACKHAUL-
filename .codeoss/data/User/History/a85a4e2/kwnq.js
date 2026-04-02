const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');

// Note: If this file is inside a "middleware" folder, change the path to '../redis'
const redisClient = require('./redis');
const logger = require('./logger'); // Import a centralized logger

/**
 * Rate limiter for sensitive authentication actions like login, refresh, password reset.
 * It limits each IP to a small number of requests in a time window to prevent brute-force attacks.
 */
const authLimiter = rateLimit({
	store: new RedisStore({
		sendCommand: (...args) => redisClient.sendCommand(args),
		prefix: 'rl:auth:',
	}),
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: process.env.RATE_LIMIT_AUTH_MAX ? parseInt(process.env.RATE_LIMIT_AUTH_MAX, 10) : 10,
	standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
	message: { message: 'Too many authentication attempts from this IP, please try again after 15 minutes.' },
	skip: (req, res) => {
		// Skip rate limiting entirely in local development
		return process.env.NODE_ENV === 'development';
	},
	handler: (req, res, next, options) => {
		logger.warn({
			message: 'Auth rate limit exceeded by IP.',
			ip: req.ip,
			method: req.method,
			url: req.originalUrl,
		});
		res.status(options.statusCode).send(options.message);
	},
});

/**
 * A more general rate limiter for all other API requests to prevent general DoS.
 */
const apiLimiter = rateLimit({
	store: new RedisStore({
		sendCommand: (...args) => redisClient.sendCommand(args),
		prefix: 'rl:api:',
	}),
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: process.env.RATE_LIMIT_API_MAX ? parseInt(process.env.RATE_LIMIT_API_MAX, 10) : 100,
	standardHeaders: true,
	legacyHeaders: false,
	message: { message: 'Too many requests from this IP, please try again after 15 minutes.' },
	skip: (req, res) => {
		// Skip rate limiting entirely in local development
		if (process.env.NODE_ENV === 'development') {
			return true;
		}

		// Skip rate limiting for the Stripe webhook to ensure we don't miss critical payment events
		return req.originalUrl === '/api/stripe/webhook';
	},
	handler: (req, res, next, options) => {
		logger.warn({
			message: 'API rate limit exceeded by IP.',
			ip: req.ip,
			method: req.method,
			url: req.originalUrl,
		});
		res.status(options.statusCode).send(options.message);
	},
});

/**
 * Stricter rate limiter specifically for file uploads to prevent storage exhaustion
 * and bandwidth abuse.
 */
const uploadLimiter = rateLimit({
	store: new RedisStore({
		sendCommand: (...args) => redisClient.sendCommand(args),
		prefix: 'rl:upload:',
	}),
	windowMs: 60 * 60 * 1000, // 1 hour window
	max: process.env.RATE_LIMIT_UPLOAD_MAX ? parseInt(process.env.RATE_LIMIT_UPLOAD_MAX, 10) : 5, // Limit each IP to 5 uploads per hour
	standardHeaders: true,
	legacyHeaders: false,
	message: { message: 'Too many file uploads from this IP, please try again after an hour.' },
	skip: (req, res) => process.env.NODE_ENV === 'development',
	handler: (req, res, next, options) => {
		logger.warn({
			message: 'Upload rate limit exceeded by IP.',
			ip: req.ip,
			method: req.method,
			url: req.originalUrl,
		});
		res.status(options.statusCode).send(options.message);
	},
});

/**
 * Strict rate limiter specifically for search/find endpoints to prevent abuse
 * that could drive up database loads and Mapbox API costs.
 */
const searchLimiter = rateLimit({
	store: new RedisStore({
		sendCommand: (...args) => redisClient.sendCommand(args),
		prefix: 'rl:search:',
	}),
	windowMs: 60 * 1000, // 1 minute window
	max: process.env.RATE_LIMIT_SEARCH_MAX ? parseInt(process.env.RATE_LIMIT_SEARCH_MAX, 10) : 30, // Limit each IP to 30 searches per minute
	standardHeaders: true,
	legacyHeaders: false,
	message: { message: 'Too many search requests from this IP, please wait a minute before trying again.' },
	skip: (req, res) => process.env.NODE_ENV === 'development',
	handler: (req, res, next, options) => {
		logger.warn({
			message: 'Search rate limit exceeded by IP.',
			ip: req.ip,
			method: req.method,
			url: req.originalUrl,
		});
		res.status(options.statusCode).send(options.message);
	},
});

module.exports = {
	authLimiter,
	apiLimiter,
	uploadLimiter,
	searchLimiter,
};