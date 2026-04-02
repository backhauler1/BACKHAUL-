const cron = require('node-cron');
const pool = require('./db');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { startCronJobs } = require('./cron');
const sendEmail = require('./email');

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
jest.mock('./email', () => jest.fn(() => Promise.resolve()));

describe('Cron Jobs - Inactivity Warnings', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should send warnings to users nearing 3 years of inactivity and update their warning flag', async () => {
        startCronJobs();
        const warningJob = cron.schedule.mock.calls.find(call => call[0] === '0 1 * * *')[1];

        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Inactive User', email: 'inactive@example.com' }] }); // SELECT
        pool.query.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE flag
        
        await warningJob();

        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0].to).toBe('inactive@example.com');
        expect(pool.query).toHaveBeenCalledWith('UPDATE users SET deletion_warning_sent = true WHERE id = $1', [1]);
    });
});

describe('Cron Jobs - Data Retention', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should anonymize inactive/suspended accounts for data retention compliance', async () => {
        startCronJobs();
        const retentionJob = cron.schedule.mock.calls.find(call => call[0] === '0 2 * * *')[1];

        pool.query.mockResolvedValueOnce({ rowCount: 3 }); // UPDATE flag
        
        await retentionJob();

        expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'));
    });
});