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

describe('Cron Jobs - S3 Cleanup', () => {
describe('Cron Jobs - Inactivity Warnings', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Suppress console output during successful tests to keep the terminal clean
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should delete orphaned S3 objects older than 1 hour', async () => {
        // Extract the callback function passed to cron.schedule for the 3:00 AM job
    it('should send warnings to users nearing 3 years of inactivity and update their warning flag', async () => {
        startCronJobs();
        const s3CleanupJob = cron.schedule.mock.calls.find(call => call[0] === '0 3 * * *')[1];
        const warningJob = cron.schedule.mock.calls.find(call => call[0] === '0 1 * * *')[1];

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
        pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Inactive User', email: 'inactive@example.com' }] }); // SELECT
        pool.query.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE flag
        
        // Verify the DeleteObjectCommand was dispatched with the correct orphaned key
        const deleteCallArg = mockS3Send.mock.calls[1][0];
        expect(deleteCallArg.type).toBe('DeleteObject');
        expect(deleteCallArg.args.Bucket).toBe(process.env.AWS_S3_BUCKET_NAME);
        expect(deleteCallArg.args.Key).toBe('companies/thumbnails/orphaned.jpg');
    });
});
        await warningJob();

describe('Cron Jobs - Compliance Documents Expiration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should send expiration emails for compliance documents nearing expiration', async () => {
        // 1. Extract the callback function passed to cron.schedule for the 9:00 AM job
        startCronJobs();
        const complianceJob = cron.schedule.mock.calls.find(call => call[0] === '0 9 * * *')[1];

        // 2. Mock the DB response to return one expiring document
        const mockExpiringDocs = [
            {
                document_type: 'Certificate of Insurance (COI)',
                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // ~7 days from now
                company_name: 'Test Logistics',
                owner_email: 'owner@example.com',
                owner_name: 'Jane Doe'
            }
        ];
        pool.query.mockResolvedValueOnce({ rows: mockExpiringDocs });

        // 3. Execute the scheduled cron function manually
        await complianceJob();

        // 4. Verify the email utility was called with the correct parsed details
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const emailArg = sendEmail.mock.calls[0][0];
        expect(emailArg.to).toBe('owner@example.com');
        expect(emailArg.subject).toContain('Compliance Document Expiration Warning: Certificate of Insurance (COI)');
        expect(emailArg.text).toContain('Test Logistics');
        expect(sendEmail.mock.calls[0][0].to).toBe('inactive@example.com');
        expect(pool.query).toHaveBeenCalledWith('UPDATE users SET deletion_warning_sent = true WHERE id = $1', [1]);
    });
});

describe('Cron Jobs - Abandoned Orders Cleanup', () => {
describe('Cron Jobs - Data Retention', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should delete pending orders older than 24 hours', async () => {
    it('should anonymize inactive/suspended accounts for data retention compliance', async () => {
        startCronJobs();
        const ordersJob = cron.schedule.mock.calls.find(call => call[0] === '0 * * * *')[1];
        const retentionJob = cron.schedule.mock.calls.find(call => call[0] === '0 2 * * *')[1];

        pool.query.mockResolvedValueOnce({ rowCount: 5 });

        await ordersJob();

        expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM orders"));
        expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status = 'pending'"));
    });
});

describe('Cron Jobs - Pickup Reminders', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should send 24-hour pickup reminders', async () => {
        startCronJobs();
        const pickupJob = cron.schedule.mock.calls.find(call => call[0] === '0 8 * * *')[1];

        const mockLoads = [
            { id: 1, title: 'Load 1', pickup_date: new Date().toISOString(), email: 'user1@test.com', name: 'User 1' },
            { id: 2, title: 'Load 2', pickup_date: new Date().toISOString(), email: 'user2@test.com', name: 'User 2' }
        ];

        pool.query.mockResolvedValueOnce({ rows: mockLoads });

        await pickupJob();

        expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("INTERVAL '1 day'"));
        expect(sendEmail).toHaveBeenCalledTimes(2);
        expect(sendEmail.mock.calls[0][0].to).toBe('user1@test.com');
        expect(sendEmail.mock.calls[1][0].to).toBe('user2@test.com');
    });
});

describe('Cron Jobs - Loading Reminders', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should send 2-hour loading reminders and update the database to prevent spam', async () => {
        startCronJobs();
        const loadingJob = cron.schedule.mock.calls.find(call => call[0] === '*/15 * * * *')[1];

        const mockLoads = [
            { id: 10, title: 'Slow Load', email: 'driver@test.com', name: 'Slow Driver' }
        ];

        // First query fetches the loads, second query updates the loading_reminder_sent flag
        pool.query.mockResolvedValueOnce({ rows: mockLoads });
        pool.query.mockResolvedValueOnce({ rowCount: 1 });

        await loadingJob();

        expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining("l.status = 'arrived'"));
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0].to).toBe('driver@test.com');
        expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining("UPDATE loads SET loading_reminder_sent = true"), [10]);
    });
});

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
        pool.query.mockResolvedValueOnce({ rowCount: 3 }); // UPDATE flag
        
        await warningJob();
        await retentionJob();

        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0].to).toBe('inactive@example.com');
        expect(pool.query).toHaveBeenCalledWith('UPDATE users SET deletion_warning_sent = true WHERE id = $1', [1]);
        expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'));
    });
});