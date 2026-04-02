const cron = require('node-cron');
const pool = require('./db');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { startCronJobs } = require('./cron');

// 1. Mock the AWS SDK S3Client and Commands
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(() => ({
        send: mockS3Send,
    })),
    // Return an object identifying the command and its arguments so we can assert on them later
    ListObjectsV2Command: jest.fn((args) => ({ type: 'ListObjects', args })),
    DeleteObjectCommand: jest.fn((args) => ({ type: 'DeleteObject', args })),
}));

// 2. Mock Database and Cron utilities
jest.mock('./db', () => ({
    query: jest.fn(),
}));
jest.mock('node-cron', () => ({
    schedule: jest.fn(),
}));

describe('Cron Jobs - S3 Cleanup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Suppress console output during successful tests to keep the terminal clean
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should delete orphaned S3 objects older than 1 hour', async () => {
        // Extract the callback function passed to cron.schedule for the 3:00 AM job
        startCronJobs();
        const s3CleanupJob = cron.schedule.mock.calls.find(call => call[0] === '0 3 * * *')[1];

        // Mock the DB response to return one valid thumbnail URL
        pool.query.mockResolvedValueOnce({
            rows: [{ thumbnail_url: 'https://my-bucket.s3.amazonaws.com/companies/thumbnails/valid.jpg' }]
        });

        // Mock the S3 ListObjectsV2Command response to return one valid and one orphaned object
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        mockS3Send.mockResolvedValueOnce({
            Contents: [
                { Key: 'companies/thumbnails/valid.jpg', LastModified: twoHoursAgo }, // Exists in DB -> Keep
                { Key: 'companies/thumbnails/orphaned.jpg', LastModified: twoHoursAgo } // Not in DB -> Delete
            ],
            IsTruncated: false
        });

        // Mock the S3 DeleteObjectCommand response
        mockS3Send.mockResolvedValueOnce({});

        // Execute the scheduled cron function manually
        await s3CleanupJob();

        // Verify S3 operations (1 ListObjects call, 1 DeleteObject call)
        expect(mockS3Send).toHaveBeenCalledTimes(2);
        
        // Verify the DeleteObjectCommand was dispatched with the correct orphaned key
        const deleteCallArg = mockS3Send.mock.calls[1][0];
        expect(deleteCallArg.type).toBe('DeleteObject');
        expect(deleteCallArg.args.Bucket).toBe(process.env.AWS_S3_BUCKET_NAME);
        expect(deleteCallArg.args.Key).toBe('companies/thumbnails/orphaned.jpg');
    });
});