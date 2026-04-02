const { Pool } = require('pg');

// Load environment variables from a .env file into process.env
require('dotenv').config();

/**
 * The `pg` library automatically reads the following environment variables
 * to configure the database connection:
 * - PGUSER: The database user.
 * - PGHOST: The database server host.
 * - PGDATABASE: The name of the database.
 * - PGPASSWORD: The user's password.
 * - PGPORT: The port the database server is running on.
 *
 * This is a secure and flexible way to manage connections without hardcoding
 * credentials in your source code.
 */
const pool = new Pool({
    // For production environments that require SSL (like Heroku or AWS RDS),
    // you might need to add the following configuration:
    // ssl: {
    //   rejectUnauthorized: false
    // }
});

// Export the configured pool so it can be used by other files.
module.exports = pool;