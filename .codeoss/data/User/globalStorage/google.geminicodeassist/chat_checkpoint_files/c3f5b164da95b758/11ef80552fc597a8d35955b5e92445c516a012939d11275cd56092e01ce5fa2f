const { Pool } = require('pg');

// Load environment variables from a .env file into process.env
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
    database: process.env.DB_NAME,
    // For production environments that require SSL, set an env var like DATABASE_URL or NODE_ENV
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Export the configured pool so it can be used by other files.
module.exports = pool;