const cron = require('node-cron');
const pool = require('./db');
const logger = require('./logger');
const sendEmail = require('./email');
const { i18next } = require('./i18nBackend');

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
 * Finds users who signed up 7 days ago but haven't completed their profile
 * (e.g., a driver hasn't added a truck, a shipper hasn't added a company)
 * and sends them a reminder email.
 */
async function notifyIncompleteProfiles() {
    const jobName = 'notifyIncompleteProfiles';
    logger.info(`[Cron] Starting job: ${jobName}`);
    
    try {
        // Find drivers who signed up a week ago and have no trucks
        const incompleteDriversQuery = `
            SELECT u.id, u.name, u.email, u.preferred_locale
            FROM users u
            LEFT JOIN trucks t ON u.id = t.owner_id
            WHERE u.created_at >= NOW() - INTERVAL '8 days' 
              AND u.created_at < NOW() - INTERVAL '7 days'
              AND 'driver' = ANY(u.roles)
            GROUP BY u.id, u.name, u.email, u.preferred_locale
            HAVING COUNT(t.id) = 0;
        `;
        const { rows: drivers } = await pool.query(incompleteDriversQuery);

        for (const driver of drivers) {
            const lng = driver.preferred_locale || 'en';
            const emailOptions = {
                to: driver.email,
                subject: i18next.t('cron.incompleteProfile.driver.subject', { lng }),
                text: i18next.t('cron.incompleteProfile.driver.text', { lng, name: driver.name }),
                html: i18next.t('cron.incompleteProfile.driver.html', { lng, name: driver.name })
            };
            await sendEmail(emailOptions);
        }
        if (drivers.length > 0) {
            logger.info(`[Cron] ${jobName}: Sent ${drivers.length} profile completion reminders to drivers.`);
        }

        // Find shippers who signed up a week ago and have no companies
        const incompleteShippersQuery = `
            SELECT u.id, u.name, u.email, u.preferred_locale
            FROM users u
            LEFT JOIN companies c ON u.id = c.owner_id
            WHERE u.created_at >= NOW() - INTERVAL '8 days' 
              AND u.created_at < NOW() - INTERVAL '7 days'
              AND NOT ('driver' = ANY(u.roles)) 
              AND NOT ('admin' = ANY(u.roles))
            GROUP BY u.id, u.name, u.email, u.preferred_locale
            HAVING COUNT(c.id) = 0;
        `;
        const { rows: shippers } = await pool.query(incompleteShippersQuery);

        for (const shipper of shippers) {
            const lng = shipper.preferred_locale || 'en';
            const emailOptions = {
                to: shipper.email,
                subject: i18next.t('cron.incompleteProfile.shipper.subject', { lng }),
                text: i18next.t('cron.incompleteProfile.shipper.text', { lng, name: shipper.name }),
                html: i18next.t('cron.incompleteProfile.shipper.html', { lng, name: shipper.name })
            };
            await sendEmail(emailOptions);
        }
        if (shippers.length > 0) {
            logger.info(`[Cron] ${jobName}: Sent ${shippers.length} profile completion reminders to shippers.`);
        }

        if (drivers.length === 0 && shippers.length === 0) {
            logger.info(`[Cron] ${jobName}: No users with incomplete profiles found.`);
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

    // Schedule to run once every day at 10:00 AM server time.
    cron.schedule('0 10 * * *', notifyIncompleteProfiles);

    logger.info('Cron jobs initialized.');
}

module.exports = { startCronJobs };