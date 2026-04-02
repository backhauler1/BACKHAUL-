const migrate = require('node-pg-migrate').default;
const path = require('path');
const { Client } = require('pg');
const logger = require('./logger');

// Database connection details from environment variables
const getDbConfig = () => ({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_NAME,
});

async function ensureDatabaseExists() {
  const dbConfig = getDbConfig();
  const { database, ...rootConfig } = dbConfig;
  const client = new Client(rootConfig);
  try {
    await client.connect();
    const res = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [database]);
    if (res.rowCount === 0) {
      logger.info(`Database "${database}" does not exist. Creating...`);
      await client.query(`CREATE DATABASE "${database}"`);
      logger.info(`Database "${database}" created.`);
    }
  } catch (err) {
    logger.error('Error checking/creating database:', err);
    throw err;
  } finally {
    await client.end();
  }
}

async function runMigrations() {
  await ensureDatabaseExists();
  const dbConfig = getDbConfig();

  const client = new Client(dbConfig);
  await client.connect();

  await migrate({
    dbClient: client,
    dir: path.join(__dirname, '../migrations'), // Assumes migrations are in a top-level /migrations directory
    direction: 'up',
    log: (msg) => logger.info(`[MIGRATE] ${msg}`),
  });

  await client.end();
}

module.exports = { runMigrations };