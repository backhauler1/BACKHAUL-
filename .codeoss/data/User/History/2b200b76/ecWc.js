const cron = require('node-cron');
const pool = require('./db');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sendEmail = require('./email');
const { i18next } = require('./i18nBackend');
const logger = require('./logger');

// Initialize the S3 Client
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * Initializes and starts all background cron jobs.
 */
const startCronJobs = () => {
    // Schedule a job to run at the top of every hour (Minute 0)
    // The cron string format is: 'minute hour day month day-of-week'
    cron.schedule('0 * * * *', async () => {
        console.log('Running cron job: Cleaning up abandoned pending orders...');
    // Run every day at 2:00 AM server time
    cron.schedule('0 2 * * *', async () => {
        try {
            // Delete orders that have been 'pending' for more than 24 hours
            const query = `
                DELETE FROM orders 
                WHERE status = 'pending' 
                AND created_at < NOW() - INTERVAL '24 hours';
            `;
            const { rowCount } = await pool.query(query);
            console.log(`Cron job finished: Deleted ${rowCount} abandoned order(s).`);
        } catch (error) {
            console.error('Error cleaning up pending orders:', error);
        }
    });

    // Schedule a job to run every day at 3:00 AM to clean up orphaned company thumbnails
    cron.schedule('0 3 * * *', async () => {
        console.log('Running cron job: Cleaning up orphaned thumbnail files from S3...');
        try {
            // 1. Get all referenced files from the database
            const query = 'SELECT thumbnail_url FROM companies WHERE thumbnail_url IS NOT NULL';
            const { rows } = await pool.query(query);
            logger.info('Running Data Retention Cron Job...');
            
            // Extract the S3 object keys from the database URLs
            const dbKeys = rows.map(row => {
                try {
                    const urlObj = new URL(row.thumbnail_url);
                    return decodeURIComponent(urlObj.pathname.substring(1)); // Remove leading slash
                } catch (e) {
                    return null; // Safely handle any malformed URLs
                }
            }).filter(Boolean);
            const dbKeysSet = new Set(dbKeys);

            // 2. List all objects in the target S3 folder (handling AWS pagination limit of 1000 items)
            let s3Objects = [];
            let isTruncated = true;
            let continuationToken = undefined;

            while (isTruncated) {
                const listCommand = new ListObjectsV2Command({
                    Bucket: process.env.AWS_S3_BUCKET_NAME,
                    Prefix: 'companies/thumbnails/',
                    ContinuationToken: continuationToken
                });
                const s3Response = await s3.send(listCommand);
                if (s3Response.Contents) {
                    s3Objects.push(...s3Response.Contents);
                }
                isTruncated = s3Response.IsTruncated;
                continuationToken = s3Response.NextContinuationToken;
            }

            // 3. Compare and delete safely
            let deletedCount = 0;
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

            for (const object of s3Objects) {
                // Delete if it's not in the DB AND it's older than 1 hour
                if (!dbKeysSet.has(object.Key) && object.LastModified < oneHourAgo) {
                    await s3.send(new DeleteObjectCommand({
                        Bucket: process.env.AWS_S3_BUCKET_NAME,
                        Key: object.Key,
                    }));
                    deletedCount++;
                }
            }

            console.log(`Cron job finished: Deleted ${deletedCount} orphaned S3 object(s).`);
        } catch (error) {
            console.error('Error cleaning up orphaned S3 files:', error);
        }
    });

    // Schedule a job to run every day at 8:00 AM to send 24-hour pickup reminders
    cron.schedule('0 8 * * *', async () => {
        console.log('Running cron job: Sending 24-hour pickup reminders...');
        try {
            // Find loads scheduled for pickup tomorrow and join with the users table to get the email and locale
            const query = `
                SELECT l.id, l.title, l.pickup_date, u.email, u.name, u.preferred_locale 
                FROM loads l
                JOIN users u ON l.owner_id = u.id
                WHERE l.pickup_date::date = (NOW() + INTERVAL '1 day')::date
            // Anonymize users who have been suspended for more than 3 years
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
            `;
            const { rows } = await pool.query(query);
            
            for (const load of rows) {
                // Fallback to English if the user hasn't set a preference
                const lng = load.preferred_locale || 'en';
                const formattedDate = new Intl.DateTimeFormat(lng).format(new Date(load.pickup_date));

                const emailOptions = {
                    to: load.email,
                    subject: i18next.t('cron.pickupReminder.subject', { lng, title: load.title }),
                    text: i18next.t('cron.pickupReminder.text', { lng, name: load.name, title: load.title, date: formattedDate }),
                    html: i18next.t('cron.pickupReminder.html', { lng, name: load.name, title: load.title, date: formattedDate })
                };
                await sendEmail(emailOptions);
            const result = await pool.query(anonymizeQuery);
            if (result.rowCount > 0) {
                logger.info(`Anonymized ${result.rowCount} inactive/suspended accounts for data retention compliance.`);
            }

            console.log(`Cron job finished: Sent ${rows.length} reminder email(s).`);
        } catch (error) {
            console.error('Error sending pickup reminders:', error);
            logger.error('Error running Data Retention Cron Job:', { error: error.message, stack: error.stack });
        }
    });

    // Schedule a job to run every 15 minutes to check for drivers who arrived > 2 hours ago
    cron.schedule('*/15 * * * *', async () => {
        console.log('Running cron job: Sending 2-hour loading reminders...');
        try {
            // Find loads where the driver arrived more than 2 hours ago but hasn't completed loading.
            // (Requires an 'arrived_at' timestamp and a 'loading_reminder_sent' boolean in the DB)
            const query = `
                SELECT l.id, l.title, u.email, u.name 
                FROM loads l
                JOIN users u ON l.driver_id = u.id
                WHERE l.status = 'arrived' 
                AND l.arrived_at < NOW() - INTERVAL '2 hours'
                AND l.loading_reminder_sent = false
            `;
            const { rows } = await pool.query(query);
            
            for (const load of rows) {
                const emailOptions = {
                    to: load.email,
                    subject: `Reminder: Are you finished loading "${load.title}"?`,
                    text: `Hi ${load.name},\n\nYou arrived at the pickup location for "${load.title}" over 2 hours ago.\n\nIf you have finished loading, please remember to click the "Completed Loading" button in the app.\n\nBest,\nYour App Team`,
                    html: `
                        <div style="font-family: sans-serif; line-height: 1.6;">
                            <h2>Loading Status Reminder</h2>
                            <p>Hi ${load.name},</p>
                            <p>You arrived at the pickup location for <strong>"${load.title}"</strong> over 2 hours ago.</p>
                            <p>If you have finished loading, please remember to click the <strong>"Completed Loading"</strong> button in the app.</p>
                            <br>
                            <p>Best,</p>
                            <p><strong>Your App Team</strong></p>
                        </div>
                    `
                };
                await sendEmail(emailOptions);
                
                // Mark the reminder as sent so we don't spam them every 15 minutes
                await pool.query('UPDATE loads SET loading_reminder_sent = true WHERE id = $1', [load.id]);
            }
            
            if (rows.length > 0) {
                console.log(`Cron job finished: Sent ${rows.length} 2-hour loading reminder(s).`);
            }
        } catch (error) {
            console.error('Error sending 2-hour loading reminders:', error);
        }
    });

    // Schedule a job to run every day at 9:00 AM to check for expiring compliance documents
    cron.schedule('0 9 * * *', async () => {
        console.log('Running cron job: Checking for expiring compliance documents...');
        try {
            // Find documents that are expiring in exactly 30, 15, 7, or 1 day(s).
            // This prevents sending a reminder for the same document every day within a range.
            const query = `
                SELECT 
                    cd.document_type, 
                    cd.expires_at,
                    c.name as company_name,
                    u.email as owner_email,
                    u.name as owner_name
                FROM company_documents cd
                JOIN companies c ON cd.company_id = c.id
                JOIN users u ON c.owner_id = u.id
                WHERE cd.expires_at IN (
                    (NOW() + INTERVAL '30 days')::date,
                    (NOW() + INTERVAL '15 days')::date,
                    (NOW() + INTERVAL '7 days')::date,
                    (NOW() + INTERVAL '1 day')::date
                )
                AND cd.is_verified = true; -- Only remind for verified documents
            `;
            const { rows: expiringDocs } = await pool.query(query);

            if (expiringDocs.length === 0) {
                console.log('Cron job finished: No expiring documents found for today.');
                return;
            }

            for (const doc of expiringDocs) {
                const expirationDate = new Date(doc.expires_at).toLocaleDateString();
                const daysUntilExpiration = Math.ceil((new Date(doc.expires_at) - new Date()) / (1000 * 60 * 60 * 24));

                const emailOptions = {
                    to: doc.owner_email,
                    subject: `Compliance Document Expiration Warning: ${doc.document_type}`,
                    text: `Hi ${doc.owner_name},\n\nThis is an automated reminder that your "${doc.document_type}" document for your company "${doc.company_name}" is set to expire in ${daysUntilExpiration} day(s), on ${expirationDate}.\n\nPlease upload a new version to your company profile to ensure your account remains in good standing.\n\nBest,\nYour App Team`,
                    html: `
                        <div style="font-family: sans-serif; line-height: 1.6;">
                            <h2>Compliance Document Expiration Warning</h2>
                            <p>Hi ${doc.owner_name},</p>
                            <p>This is an automated reminder that your <strong>"${doc.document_type}"</strong> document for your company <strong>"${doc.company_name}"</strong> is set to expire in <strong>${daysUntilExpiration} day(s)</strong>, on ${expirationDate}.</p>
                            <p>Please upload a new version to your company profile to ensure your account remains in good standing and continues to be visible to shippers.</p>
                            <br><p>Best,</p><p><strong>Your App Team</strong></p>
                        </div>
                    `
                };
                
                await sendEmail(emailOptions).catch(emailError => console.error(`Failed to send expiration email for company ${doc.company_name} to ${doc.owner_email}:`, emailError));
            }

            console.log(`Cron job finished: Sent ${expiringDocs.length} document expiration reminder(s).`);
        } catch (error) {
            console.error('Error checking for expiring compliance documents:', error);
        }
    });
    
    // Add any future scheduled tasks here...
};

module.exports = { startCronJobs };