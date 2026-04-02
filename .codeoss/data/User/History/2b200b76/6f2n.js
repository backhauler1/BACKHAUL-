const cron = require('node-cron');
const pool = require('./db');
const fs = require('fs').promises;
const path = require('path');

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
        console.log('Running cron job: Cleaning up orphaned thumbnail files...');
        try {
            const uploadsDir = path.join(__dirname, 'uploads', 'companies', 'thumbnails');
            
            // 1. Get all files on disk
            let filesOnDisk = [];
            try {
                filesOnDisk = await fs.readdir(uploadsDir);
            } catch (err) {
                if (err.code === 'ENOENT') return; // Directory doesn't exist yet, nothing to clean up
                throw err;
            }

            // 2. Get all referenced files from the database
            const query = 'SELECT thumbnail_url FROM companies WHERE thumbnail_url IS NOT NULL';
            const { rows } = await pool.query(query);
            
            // Extract just the filenames from the database URLs
            const filesInDb = rows.map(row => path.basename(row.thumbnail_url));
            const dbFilesSet = new Set(filesInDb); // Use a Set for faster lookups

            // 3. Compare and delete safely
            let deletedCount = 0;
            const oneHourAgo = Date.now() - 60 * 60 * 1000;

            for (const file of filesOnDisk) {
                if (file.startsWith('.')) continue; // Skip hidden system files

                const filePath = path.join(uploadsDir, file);
                const stats = await fs.stat(filePath);

                // Delete if it's not in the DB AND it's older than 1 hour
                if (!dbFilesSet.has(file) && stats.mtimeMs < oneHourAgo) {
                    await fs.unlink(filePath);
                    deletedCount++;
                }
            }

            console.log(`Cron job finished: Deleted ${deletedCount} orphaned file(s).`);
        } catch (error) {
            console.error('Error cleaning up orphaned files:', error);
        }
    });
};

module.exports = { startCronJobs };