const cron = require('node-cron');
const pool = require('./db');
const logger = require('./logger');

/**
 * Deletes old, unmatched load postings to keep the database clean and relevant.
 * A load is considered "stale" if it was created more than 30 days ago
 * and has not been matched with a transporter.
 */
async function cleanupStaleLoads() {
    const jobName = 'cleanupStaleLoads';
    logger.info(`[Cron] Starting job: ${jobName}`);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    try {
        // Assuming 'created_at' is the timestamp column for a load posting
        const result = await pool.query(
            `DELETE FROM loads
             WHERE created_at < $1
               AND status = 'available' -- Or whatever status indicates it's an open posting
               AND id NOT IN (SELECT load_id FROM matches)`,
            [thirtyDaysAgo.toISOString()]
        );

        if (result.rowCount > 0) {
            logger.info(`[Cron] ${jobName}: Cleaned up ${result.rowCount} stale load postings.`);
        } else {
            logger.info(`[Cron] ${jobName}: No stale loads to clean up.`);
        }
    } catch (error) {
        logger.error(`[Cron] Job ${jobName} failed:`, { error: error.message, stack: error.stack });
    }
}

/**
 * Initializes all scheduled background jobs for the application.
 */
function startCronJobs() {
    // Schedule to run once every day at 3:00 AM server time.
    cron.schedule('0 3 * * *', cleanupStaleLoads);

    logger.info('Cron jobs initialized.');
}

module.exports = { startCronJobs };