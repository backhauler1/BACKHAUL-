const cron = require('node-cron');
const pool = require('./db');
const { startCronJobs } = require('./cron');
const sendEmail = require('./email');
const logger = require('./logger');
const { i18next } = require('./i18nBackend');

// Mock all external dependencies
jest.mock('./db', () => ({
    query: jest.fn(),
}));
jest.mock('node-cron', () => ({
    schedule: jest.fn(),
}));
jest.mock('./email');
jest.mock('./logger');
jest.mock('./i18nBackend', () => ({
    i18next: {
        t: jest.fn((key, options) => `[${options.lng}] ${key}`),
    }
}));

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
    });

    describe('cleanupStaleLoads (0 3 * * *)', () => {
        let cleanupJob;
        beforeEach(() => {
            cleanupJob = scheduledJobs['0 3 * * *'];
        });

        it('should delete stale loads and log the count', async () => {
            pool.query.mockResolvedValue({ rowCount: 5 });
            await cleanupJob();
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM loads'), expect.any(Array));
            expect(logger.info).toHaveBeenCalledWith('[Cron] cleanupStaleLoads: Cleaned up 5 stale load postings.');
        });

        it('should log that no loads were cleaned up if rowCount is 0', async () => {
            pool.query.mockResolvedValue({ rowCount: 0 });
            await cleanupJob();
            expect(logger.info).toHaveBeenCalledWith('[Cron] cleanupStaleLoads: No stale loads to clean up.');
        });

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

    describe('notifyIncompleteProfiles (0 10 * * *)', () => {
        let notifyJob;
        beforeEach(() => {
            notifyJob = scheduledJobs['0 10 * * *'];
        });

        it('should send reminder emails to drivers with incomplete profiles', async () => {
            const mockIncompleteDrivers = [
                { id: 1, name: 'Driver One', email: 'driver1@test.com', preferred_locale: 'en' },
            ];
            pool.query
                .mockResolvedValueOnce({ rows: mockIncompleteDrivers })
                .mockResolvedValueOnce({ rows: [] });

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