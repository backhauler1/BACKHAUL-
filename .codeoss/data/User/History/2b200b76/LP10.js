const cron = require('node-cron');
const pool = require('./db');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sendEmail = require('./email');

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
            // Find loads scheduled for pickup tomorrow and join with the users table to get the email
            const query = `
                SELECT l.id, l.title, l.pickup_date, u.email, u.name 
                FROM loads l
                JOIN users u ON l.owner_id = u.id
                WHERE l.pickup_date::date = (NOW() + INTERVAL '1 day')::date
            `;
            const { rows } = await pool.query(query);
            
            for (const load of rows) {
                const emailOptions = {
                    to: load.email,
                    subject: `Reminder: Upcoming Pickup for Load "${load.title}"`,
                    text: `Hi ${load.name},\n\nThis is a reminder that your load "${load.title}" is scheduled for pickup tomorrow (${new Date(load.pickup_date).toLocaleDateString()}).\n\nPlease ensure everything is ready for the driver.\n\nBest,\nYour App Team`,
                    html: `
                        <div style="font-family: sans-serif; line-height: 1.6;">
                            <h2>Pickup Reminder</h2>
                            <p>Hi ${load.name},</p>
                            <p>This is a reminder that your load <strong>"${load.title}"</strong> is scheduled for pickup tomorrow (<strong>${new Date(load.pickup_date).toLocaleDateString()}</strong>).</p>
                            <p>Please ensure everything is ready for the driver.</p>
                            <br>
                            <p>Best,</p>
                            <p><strong>Your App Team</strong></p>
                        </div>
                    `
                };
                await sendEmail(emailOptions);
            }

            console.log(`Cron job finished: Sent ${rows.length} reminder email(s).`);
        } catch (error) {
            console.error('Error sending pickup reminders:', error);
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
};

module.exports = { startCronJobs };