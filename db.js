const { Pool } = require('pg');

// Load environment variables from a .env file into process.env
require('dotenv').config();

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    // For production environments that require SSL, set an env var like DATABASE_URL or NODE_ENV
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
};

if (process.env.DB_PORT) {
    config.port = parseInt(process.env.DB_PORT, 10);
}
const pool = new Pool(config);

// Export the configured pool so it can be used by other files.
module.exports = pool;