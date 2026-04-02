const cron = require('node-cron');
const pool = require('./db');
const logger = require('./logger');
const sendEmail = require('./email');

const startCronJobs = () => {
    // Run every day at 1:00 AM server time
    cron.schedule('0 1 * * *', async () => {
        try {
            logger.info('Running Inactivity Warning Cron Job...');
            
            // Find active users who have been inactive for at least 2 years and 11 months 
            // (30 days before the 3-year deletion threshold)
            const warningQuery = `
                SELECT id, name, email 
                FROM users 
                WHERE name != 'Deleted User'
                  AND is_suspended = false
                  AND deletion_warning_sent = false
                  AND (
                      (last_login_at < NOW() - INTERVAL '3 years' + INTERVAL '30 days')
                      OR (last_login_at IS NULL AND created_at < NOW() - INTERVAL '3 years' + INTERVAL '30 days')
                  )
            `;
            
            const { rows: usersToWarn } = await pool.query(warningQuery);

            for (const user of usersToWarn) {
                const emailOptions = {
                    to: user.email,
                    subject: 'Action Required: Your account is scheduled for deletion',
                    text: `Hi ${user.name},\n\nYour account has been inactive for nearly 3 years. To comply with data privacy regulations, your account and personal data will be permanently deleted in 30 days.\n\nIf you wish to keep your account active, simply log in to our application before then.\n\nBest,\nYour App Team`,
                    html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Account Deletion Notice</h2><p>Hi ${user.name},</p><p>Your account has been inactive for nearly 3 years. To comply with data privacy regulations, your account and personal data will be permanently deleted in 30 days.</p><p><strong>If you wish to keep your account active, simply log in to our application before then.</strong></p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
                };
                
                await sendEmail(emailOptions);
                await pool.query('UPDATE users SET deletion_warning_sent = true WHERE id = $1', [user.id]);
            }
            
            if (usersToWarn.length > 0) {
                logger.info(`Sent inactivity warnings to ${usersToWarn.length} users.`);
            }
        } catch (error) {
            logger.error('Error running Inactivity Warning Cron Job:', { error: error.message, stack: error.stack });
        }
    });

    // Run every day at 2:00 AM server time
    cron.schedule('0 2 * * *', async () => {
        try {
            logger.info('Running Data Retention Cron Job...');
            
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