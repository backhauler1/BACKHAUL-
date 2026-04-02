const cron = require('node-cron');
const pool = require('./db');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { startCronJobs } = require('./cron');
const sendEmail = require('./email');
const logger = require('./logger');
const { i18next } = require('./i18nBackend');

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
// Mock all external dependencies
jest.mock('./db', () => ({
    query: jest.fn(),
}));
jest.mock('node-cron', () => ({
    schedule: jest.fn(),
}));
jest.mock('./email', () => jest.fn(() => Promise.resolve()));
jest.mock('./email');
jest.mock('./logger');
jest.mock('./i18nBackend', () => ({
    i18next: {
        t: jest.fn((key, options) => `[${options.lng}] ${key}`),
    }
}));

describe('Cron Jobs - Inactivity Warnings', () => {
describe('Cron Jobs', () => {
    let scheduledJobs = {};

    beforeAll(() => {
        // Capture all scheduled jobs when startCronJobs is called
        cron.schedule.mockImplementation((schedule, callback) => {
            scheduledJobs[schedule] = callback;
        });
        startCronJobs();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should send warnings to users nearing 3 years of inactivity and update their warning flag', async () => {
        startCronJobs();
        const warningJob = cron.schedule.mock.calls.find(call => call[0] === '0 1 * * *')[1];
    describe('cleanupStaleLoads (0 3 * * *)', () => {
        let cleanupJob;
        beforeEach(() => {
            cleanupJob = scheduledJobs['0 3 * * *'];
        });

        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Inactive User', email: 'inactive@example.com' }] }); // SELECT
        pool.query.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE flag
        
        await warningJob();
        it('should delete stale loads and log the count', async () => {
            pool.query.mockResolvedValue({ rowCount: 5 });
            await cleanupJob();
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM loads'), expect.any(Array));
            expect(logger.info).toHaveBeenCalledWith('[Cron] cleanupStaleLoads: Cleaned up 5 stale load postings.');
        });

        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0].to).toBe('inactive@example.com');
        expect(pool.query).toHaveBeenCalledWith('UPDATE users SET deletion_warning_sent = true WHERE id = $1', [1]);
    });
});
        it('should log that no loads were cleaned up if rowCount is 0', async () => {
            pool.query.mockResolvedValue({ rowCount: 0 });
            await cleanupJob();
            expect(logger.info).toHaveBeenCalledWith('[Cron] cleanupStaleLoads: No stale loads to clean up.');
        });

describe('Cron Jobs - Data Retention', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        it('should log an error if the database query fails', async () => {
            const dbError = new Error('DB connection failed');
            pool.query.mockRejectedValue(dbError);
            await cleanupJob();
            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining('cleanupStaleLoads failed'),
                expect.objectContaining({ error: 'DB connection failed' })
            );
        });
    });

    it('should anonymize inactive/suspended accounts for data retention compliance', async () => {
        startCronJobs();
        const retentionJob = cron.schedule.mock.calls.find(call => call[0] === '0 2 * * *')[1];
    describe('notifyIncompleteProfiles (0 10 * * *)', () => {
        let notifyJob;
        beforeEach(() => {
            notifyJob = scheduledJobs['0 10 * * *'];
        });

        pool.query.mockResolvedValueOnce({ rowCount: 3 }); // UPDATE flag
        
        await retentionJob();
        it('should send reminder emails to drivers with incomplete profiles', async () => {
            const mockIncompleteDrivers = [
                { id: 1, name: 'Driver One', email: 'driver1@test.com', preferred_locale: 'en' },
            ];
            pool.query
                .mockResolvedValueOnce({ rows: mockIncompleteDrivers })
                .mockResolvedValueOnce({ rows: [] });

        expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'));
            await notifyJob();

            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("LEFT JOIN trucks"));
            expect(sendEmail).toHaveBeenCalledTimes(1);
            expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
                to: 'driver1@test.com',
                subject: '[en] cron.incompleteProfile.driver.subject',
            }));
            expect(logger.info).toHaveBeenCalledWith('[Cron] notifyIncompleteProfiles: Sent 1 profile completion reminders to drivers.');
        });

        it('should log that no users were found if both queries are empty', async () => {
            pool.query.mockResolvedValue({ rows: [] });
            await notifyJob();
            expect(sendEmail).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith('[Cron] notifyIncompleteProfiles: No users with incomplete profiles found.');
        });
    });
});