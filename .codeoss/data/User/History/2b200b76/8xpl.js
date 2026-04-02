const cron = require('node-cron');
const pool = require('./db');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

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
};

module.exports = { startCronJobs };