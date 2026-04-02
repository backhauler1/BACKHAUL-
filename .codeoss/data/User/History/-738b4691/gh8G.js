const redis = require('redis');

// Initialize the Redis client using the v4 API
const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));

// Connect to the Redis server
if (process.env.NODE_ENV !== 'test') {
    (async () => {
        try {
            await redisClient.connect();
        } catch (err) {
            console.error('Redis connection failed:', err);
        }
    })();
}

module.exports = redisClient;