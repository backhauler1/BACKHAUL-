const cron = require('node-cron');
const pool = require('./db');
const logger = require('./logger');

const startCronJobs = () => {
    // Run every day at 2:00 AM server time
    cron.schedule('0 2 * * *', async () => {
        try {
            logger.info('Running Data Retention Cron Job...');
            
            // Anonymize users who have been suspended for more than 3 years
            // Anonymize users who have been suspended OR inactive for more than 3 years
            // Adjust the interval based on your specific legal requirements / local laws.
            const anonymizeQuery = `
                UPDATE users 
                SET 
                    name = 'Deleted User', 
                    email = 'deleted_' || id || '@example.com', 
                    password = 'deleted', 
                    referral_code = NULL, 
                    refresh_token = NULL,
                    preferred_locale = NULL
                WHERE is_suspended = true 
                  AND created_at < NOW() - INTERVAL '3 years'
                  AND name != 'Deleted User'; -- Prevent re-anonymizing and polluting logs
                WHERE name != 'Deleted User' -- Prevent re-anonymizing and polluting logs
                  AND (
                      (is_suspended = true AND created_at < NOW() - INTERVAL '3 years')
                      OR (last_login_at < NOW() - INTERVAL '3 years')
                      OR (last_login_at IS NULL AND created_at < NOW() - INTERVAL '3 years')
                  );
            `;
            
            const result = await pool.query(anonymizeQuery);
            if (result.rowCount > 0) {
                logger.info(`Anonymized ${result.rowCount} inactive/suspended accounts for data retention compliance.`);
            }
        } catch (error) {
            logger.error('Error running Data Retention Cron Job:', { error: error.message, stack: error.stack });
        }
    });
    
    // Add any future scheduled tasks here...
};

module.exports = { startCronJobs };