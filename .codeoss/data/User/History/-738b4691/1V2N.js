const redis = require('redis');

// Initialize the Redis client using the v4 API
const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));

// Connect to the Redis server
(async () => {
    await redisClient.connect();
})();

module.exports = redisClient;