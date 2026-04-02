const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const pool = require('./db');
const multer = require('multer');

// Set environment variables before any modules are loaded
process.env.MAPBOX_TOKEN = 'pk.eyJ1IjoicGVycnltY2theTEiLCJhIjoiY2x5dzk0eGk4MDRtZTJqcW12dG16d2JldCJ9.jHj-25a24V33A351pY--gA';

// 1. Mock Database Interactions
jest.mock('./db', () => ({
    query: jest.fn(),
    connect: jest.fn(),
}));

// 2. Mock Authentication and Authorization Middleware
jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        // Mock an authenticated user with ID 1
        req.user = { id: 1, roles: ['user'] };
        next();
    },
    authorize: () => (req, res, next) => next(),
}));

// 3. Mock Redis, Email, and AWS S3
jest.mock('./redis', () => ({
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
})).mockName('redisClient');
jest.mock('./email', () => jest.fn(() => Promise.resolve()));

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(() => ({ send: mockS3Send })),
    GetObjectCommand: jest.fn((args) => ({ type: 'GetObject', args })),
}));
jest.mock('./s3', () => ({
    ...jest.requireActual('./s3'),
    getObjectStream: jest.fn(),
    getS3KeyFromUrl: (url) => new URL(url).pathname.substring(1),
}));

// 4. Mock Multer and Multer-S3
jest.mock('multer-s3', () => jest.fn(() => 'mock-s3-storage'));
jest.mock('multer');
const mockSingle = jest.fn();
const mockNone = jest.fn(() => (req, res, next) => next());
multer.mockReturnValue({ 
    single: mockSingle,
    none: mockNone
});
jest.mock('./uploads', () => ({
    upload: { single: mockSingle },
    uploadSignedBol: { single: mockSingle },
}));
 
// 5. Mock the resilient geocoding service
const { geocodeAddress } = require('./geocodingService');
jest.mock('./geocodingService'); // Must be mocked to control its behavior

// Setup Express application for testing
const loadsRouter = require('./loads');
const app = express();
app.use(express.json()); // Parses JSON bodies sent by supertest
app.use(express.urlencoded({ extended: true }));
app.use('/api/loads', loadsRouter);

describe('Loads API - POST /post', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Suppress console output for expected error cases to keep tests clean
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Default setup: mock multer attaching a file unless a specific header is passed
        mockSingle.mockImplementation(() => (req, res, next) => {
            if (!req.headers['x-no-file']) {
                req.file = { location: 'https://mock-bucket.s3.amazonaws.com/loads/bols/mock-bol.pdf' };
            }
            next();
        });

        // Default setup: Geocoding service successfully finds coordinates
        geocodeAddress.mockResolvedValue([-74.0060, 40.7128]);
    });

    it('should successfully post a new load and attach geocoded coordinates', async () => {
        // 2. Mock DB returning the newly inserted load
        const mockNewLoad = { id: 10, title: 'Test Machinery Load', pickup_lng: -74.0060, pickup_lat: 40.7128 };
        pool.query.mockResolvedValueOnce({ rows: [mockNewLoad] });

        const res = await request(app)
            .post('/api/loads/post')
            .send({
                title: 'Test Machinery Load',
                pickupAddress: 'New York, NY', // This will be geocoded
                deliveryAddress: 'Los Angeles, CA',
            });

        expect(res.statusCode).toBe(201);
        expect(res.body.message).toBe('Load posted successfully!');
        expect(res.body.data).toEqual(mockNewLoad);
        
        // Verify the insert query was executed
        const insertArgs = pool.query.mock.calls[0][1];
        expect(insertArgs[9]).toBe(-74.0060); // pickup_lng
        expect(insertArgs[10]).toBe(40.7128); // pickup_lat

        expect(geocodeAddress).toHaveBeenCalledWith('New York, NY');
    });

    it('should successfully post a load with null coordinates if geocoding fails', async () => {
        // Mock geocoding returning null
        geocodeAddress.mockResolvedValue(null);

        const mockNewLoad = { id: 11, title: 'Test Load', pickup_lng: null, pickup_lat: null };
        pool.query.mockResolvedValueOnce({ rows: [mockNewLoad] });

        const res = await request(app)
            .post('/api/loads/post')
            .send({ title: 'Test Load', pickupAddress: 'Nowhere', deliveryAddress: 'LA' });

        expect(res.statusCode).toBe(201);
        expect(res.body.data.pickup_lng).toBeNull();
        expect(res.body.data.pickup_lat).toBeNull();

        // Verify the insert query was called with null coordinates
        const insertArgs = pool.query.mock.calls[0][1];
        expect(insertArgs[9]).toBeNull(); // pickup_lng
        expect(insertArgs[10]).toBeNull(); // pickup_lat
    });
});

describe('Loads API - POST /find', () => {
    const redisClient = require('./redis');
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should return cached data from Redis if available', async () => {
        // 1. Mock Redis to return a cached result
        const mockCachedData = {
            data: [{ id: 1, title: 'Cached Load' }],
            pagination: { currentPage: 1, totalPages: 1, totalItems: 1 }
        };
        redisClient.get.mockResolvedValueOnce(JSON.stringify(mockCachedData));

        const res = await request(app)
            .post('/api/loads/find')
            .send({}); 

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(mockCachedData);
        expect(redisClient.get).toHaveBeenCalledTimes(1);
        expect(pool.query).not.toHaveBeenCalled(); // Should not hit the DB
    });

    it('should query the database, cache the result, and apply filters if cache misses', async () => {
        redisClient.get.mockResolvedValue(null); // Cache miss

        const mockCountRows = [{ count: '1' }];
        const mockLoadRows = [{ id: 2, title: 'DB Load', pickup_date: '2023-10-25' }];

        pool.query.mockResolvedValueOnce({ rows: mockCountRows }); // COUNT query
        pool.query.mockResolvedValueOnce({ rows: mockLoadRows });  // SELECT query

        const res = await request(app)
            .post('/api/loads/find')
            .send({
                startDate: '2023-10-20'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual(mockLoadRows);
        
        // Verify DB was called with filters
        const selectQuery = pool.query.mock.calls[1][0];
        expect(selectQuery).toContain('AND pickup_date >= $1');
        
        // Verify Redis SET was called
        expect(redisClient.setEx).toHaveBeenCalledTimes(1);
        expect(redisClient.setEx).toHaveBeenCalledWith(
            expect.stringContaining('loads:find:'),
            60,
            JSON.stringify({
                data: mockLoadRows,
                pagination: { currentPage: 1, totalPages: 1, totalItems: 1 }
            })
        );
    });

    it('should gracefully fall back to the database if Redis GET fails', async () => {
        // 1. Mock Redis to throw an error
        redisClient.get.mockRejectedValueOnce(new Error('Redis connection lost'));

        pool.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app).post('/api/loads/find').send({});

        expect(res.statusCode).toBe(200);
        expect(pool.query).toHaveBeenCalledTimes(1); // Should call the fallback DB function
    });
});

describe('Loads API - Interaction Endpoints', () => {
    let mockClient;
    const sendEmail = require('./email');

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    describe('PATCH /:id/accept', () => {
        it('should successfully accept a load, commit transaction, and send emails', async () => {
            // Mock DB: 1. Update load status (success)
            const mockAcceptedLoad = { title: 'New Load', owner_id: 2, accepted_at: new Date().toISOString() };
            pool.query.mockResolvedValueOnce({ rows: [mockAcceptedLoad] });
            // Mock DB: 2. Fetch shipper info
            pool.query.mockResolvedValueOnce({ rows: [{ email: 'shipper@test.com', name: 'Shipper' }] });
            // Mock DB: 3. Fetch driver info
            pool.query.mockResolvedValueOnce({ rows: [{ email: 'driver@test.com', name: 'Driver' }] });

            const res = await request(app).patch('/api/loads/10/accept');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Load accepted successfully!');
            
            // Verify DB update
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE loads SET status = 'assigned'"), [1, '10']);

            // Verify emails were sent to both parties
            expect(sendEmail).toHaveBeenCalledTimes(2);
            expect(sendEmail.mock.calls[0][0].to).toBe('shipper@test.com');
            expect(sendEmail.mock.calls[1][0].to).toBe('driver@test.com');
        });

        it('should return 400 if the load is no longer available', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] }); // Update returns no rows

            const res = await request(app).patch('/api/loads/10/accept');

            expect(res.statusCode).toBe(400);
            expect(res.body.message).toBe('Load is no longer available or has already been accepted.');
        });
    });

    describe('PATCH /:id/cancel-acceptance', () => {
        it('should cancel within the grace period without penalty', async () => {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
            const mockLoadInfo = { accepted_at: fiveMinutesAgo, title: 'Grace Period Load', owner_id: 2 };
            
            pool.query.mockResolvedValueOnce({ rows: [mockLoadInfo] }); // Fetch load
            pool.query.mockResolvedValueOnce({ rowCount: 1 }); // Revert load status
            pool.query.mockResolvedValueOnce({ rows: [{ email: 'shipper@test.com', name: 'Shipper' }] }); // Fetch shipper

            const res = await request(app).patch('/api/loads/11/cancel-acceptance');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Acceptance canceled. The load is back on the market.');
            expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE users SET penalty_count'));
            expect(sendEmail).toHaveBeenCalledTimes(1);
        });

        it('should cancel outside the grace period and apply a penalty', async () => {
            const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            const mockLoadInfo = { accepted_at: thirtyMinutesAgo, title: 'Penalty Load', owner_id: 2 };
            
            pool.query.mockResolvedValueOnce({ rows: [mockLoadInfo] }); // Fetch load
            pool.query.mockResolvedValueOnce({ rowCount: 1 }); // Apply penalty
            pool.query.mockResolvedValueOnce({ rowCount: 1 }); // Revert load status
            pool.query.mockResolvedValueOnce({ rows: [{ email: 'shipper@test.com', name: 'Shipper' }] }); // Fetch shipper

            const res = await request(app).patch('/api/loads/12/cancel-acceptance');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toContain('A penalty has been applied to your account');
            expect(pool.query).toHaveBeenCalledWith('UPDATE users SET penalty_count = COALESCE(penalty_count, 0) + 1 WHERE id = $1', [1]);
            expect(sendEmail).toHaveBeenCalledTimes(1);
        });
    });
});

describe('Loads API - DELETE /:id (Shipper Cancel)', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});

        mockClient = {
            query: jest.fn(),
            release: jest.fn(),
        };
        pool.connect.mockResolvedValue(mockClient);
    });

    it('should successfully cancel a load, log the reason, and commit the transaction', async () => {
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: 10, title: 'A Load to Cancel' }] }); // DELETE succeeds
        mockClient.query.mockResolvedValueOnce({}); // INSERT log succeeds
        mockClient.query.mockResolvedValueOnce({}); // COMMIT

        const res = await request(app).delete('/api/loads/10?reason=Changed%20mind');

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Load successfully cancelled and removed from the market.');

        // Verify transaction flow
        expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM loads'), [10, 1]);
        expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO cancellation_logs'), [10, 'A Load to Cancel', 1, 'Changed mind']);
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
        expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should use a default reason if none is provided', async () => {
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: 10, title: 'A Load to Cancel' }] });
        mockClient.query.mockResolvedValueOnce({});
        mockClient.query.mockResolvedValueOnce({});

        await request(app).delete('/api/loads/10'); // No reason in query

        expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO cancellation_logs'), [10, 'A Load to Cancel', 1, 'No reason provided']);
    });

    it('should return 400 and rollback if the load is already assigned or not owned by the user', async () => {
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({ rows: [] }); // DELETE fails (returns no rows)

        const res = await request(app).delete('/api/loads/10');

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Cannot cancel this load. It may already be assigned or you do not have permission.');
        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should return 500 and rollback if the logging fails mid-transaction', async () => {
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: 10, title: 'A Load to Cancel' }] }); // DELETE succeeds
        mockClient.query.mockRejectedValueOnce(new Error('Logging failed')); // INSERT fails

        const res = await request(app).delete('/api/loads/10');

        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('Internal server error while canceling load.');
        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
});

describe('Loads API - Bidding Endpoints', () => {
    let mockClient;
    const sendEmail = require('./email');

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});

        mockClient = {
            query: jest.fn(),
            release: jest.fn(),
        };
        pool.connect.mockResolvedValue(mockClient);
    });

    describe('POST /:id/bid', () => {
        it('should successfully place a bid', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ status: 'available', owner_id: 2 }] }); // Load check
            const mockBid = { id: 1, bid_amount: 500, notes: 'Can do' };
            pool.query.mockResolvedValueOnce({ rows: [mockBid] }); // Insert bid
    
            const res = await request(app)
                .post('/api/loads/10/bid')
                .send({ bidAmount: 500, notes: 'Can do' });

            expect(res.statusCode).toBe(201);
            expect(res.body.message).toBe('Bid placed successfully.');
            expect(res.body.data).toEqual(mockBid);
        });

        it('should return 400 if user tries to bid on their own load', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ status: 'available', owner_id: 1 }] }); // Owner is 1 (current user)
    
            const res = await request(app).post('/api/loads/10/bid').send({ bidAmount: 500 });

            expect(res.statusCode).toBe(400);
            expect(res.body.message).toBe('You cannot bid on your own load.');
        });
    });

    describe('GET /:id/bids', () => {
        it('should return bids if the user is the load owner', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 1 }] }); // Load check (owner_id matches req.user.id)
            const mockBids = [{ id: 1, bid_amount: 500 }];
            pool.query.mockResolvedValueOnce({ rows: mockBids }); // Bids query

            const res = await request(app).get('/api/loads/10/bids');

            expect(res.statusCode).toBe(200);
            expect(res.body.data).toEqual(mockBids);
        });

        it('should return 403 if the user is not the load owner', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 2 }] }); // User is not the owner
    
            const res = await request(app).get('/api/loads/10/bids');

            expect(res.statusCode).toBe(403);
            expect(res.body.message).toBe('Only the load owner can view bids.');
        });
    });

    describe('POST /:id/bids/:bidId/accept', () => {
        it('should accept a bid, assign the load, and send an email', async () => {
            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            mockClient.query.mockResolvedValueOnce({ rows: [{ status: 'available', title: 'Test Load' }] }); // Load check
            mockClient.query.mockResolvedValueOnce({ rows: [{ driver_id: 3, bid_amount: 500 }] }); // Bid check
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // Active load check (driver is free)
            mockClient.query.mockResolvedValueOnce({}); // UPDATE loads
            mockClient.query.mockResolvedValueOnce({}); // UPDATE bids (accept)
            mockClient.query.mockResolvedValueOnce({}); // UPDATE bids (reject others)
            mockClient.query.mockResolvedValueOnce({ rows: [{ email: 'driver@test.com', name: 'Driver' }] }); // Fetch driver
            mockClient.query.mockResolvedValueOnce({}); // COMMIT

            const res = await request(app).post('/api/loads/10/bids/5/accept');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Bid accepted and load assigned successfully.');
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
            expect(mockClient.release).toHaveBeenCalledTimes(1);
            
            expect(sendEmail).toHaveBeenCalledTimes(1);
            expect(sendEmail.mock.calls[0][0].to).toBe('driver@test.com');
        });

        it('should return 409 if the driver has another active load', async () => {
            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            mockClient.query.mockResolvedValueOnce({ rows: [{ status: 'available' }] });
            mockClient.query.mockResolvedValueOnce({ rows: [{ driver_id: 3, bid_amount: 500 }] });
            mockClient.query.mockResolvedValueOnce({ rows: [{ id: 99 }] }); // Active load found

            const res = await request(app).post('/api/loads/10/bids/5/accept');

            expect(res.statusCode).toBe(409);
            expect(res.body.message).toBe('The driver cannot be assigned because they have another active trip.');
            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });
    });
});

describe('Loads API - Rating and Review Endpoints', () => {
    let mockClient;
    const redisClient = require('./redis');
    const sendEmail = require('./email');

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});

        mockClient = {
            query: jest.fn(),
            release: jest.fn(),
        };
        pool.connect.mockResolvedValue(mockClient);
    });

    describe('POST /:id/rate', () => {
        it('should successfully submit a rating and update user average', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 2, driver_id: 1, status: 'delivered' }] });

            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // No existing rating
            mockClient.query.mockResolvedValueOnce({}); // INSERT into load_ratings
            mockClient.query.mockResolvedValueOnce({ rows: [{ rating: '4.0', rating_count: 1, email: 'target@test.com', name: 'Target' }] }); // SELECT old user stats
            mockClient.query.mockResolvedValueOnce({ rows: [{ rating: '4.5' }] }); // UPDATE users RETURNING new rating
            mockClient.query.mockResolvedValueOnce({}); // COMMIT

            const res = await request(app)
                .post('/api/loads/20/rate')
                .send({ rating: 5, targetUserId: 2, review: 'Great!' });

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Rating submitted successfully!');
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT'); // Check transaction commit
            expect(redisClient.del).toHaveBeenCalledWith('user:2:reviews:page:1:limit:5');
            expect(sendEmail).not.toHaveBeenCalled(); // Rating did not drop, so no email
        });

        it('should send a rating alert email if the average drops below 3', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 2, driver_id: 1, status: 'delivered' }] });

            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // No existing rating
            mockClient.query.mockResolvedValueOnce({}); // INSERT
            // Mock user who had a good rating, but this new rating will drop them
            mockClient.query.mockResolvedValueOnce({ rows: [{ rating: '4.0', rating_count: 1, email: 'target@test.com', name: 'Target User' }] });
            mockClient.query.mockResolvedValueOnce({ rows: [{ rating: '2.5' }] }); // The new average is below 3
            mockClient.query.mockResolvedValueOnce({}); // COMMIT

            await request(app)
                .post('/api/loads/20/rate')
                .send({ rating: 1, targetUserId: 2, review: 'Bad experience' });

            expect(sendEmail).toHaveBeenCalledTimes(1);
            expect(sendEmail.mock.calls[0][0].subject).toContain('Action Required: Your Average Rating Dropped');
        });

        it('should return 400 if a rating has already been submitted', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 2, driver_id: 1, status: 'delivered' }] }); // Load check
            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            mockClient.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // Existing rating found
            mockClient.query.mockResolvedValueOnce({}); // ROLLBACK

            const res = await request(app)
                .post('/api/loads/20/rate')
                .send({ rating: 5, targetUserId: 2 });

            expect(res.statusCode).toBe(400);
            expect(res.body.message).toBe('You have already submitted a rating for this load.');
        });
    });

    describe('PUT /:id/rate', () => {
        it('should successfully update an existing rating', async () => {
            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            // Original rating was 3 stars
            mockClient.query.mockResolvedValueOnce({ rows: [{ target_id: 2, rating: 3 }] });
            // User stats before update
            mockClient.query.mockResolvedValueOnce({ rows: [{ rating: '3.5', rating_count: 2, email: 'target@test.com', name: 'Target' }] });
            mockClient.query.mockResolvedValueOnce({}); // UPDATE load_ratings
            mockClient.query.mockResolvedValueOnce({}); // UPDATE users
            mockClient.query.mockResolvedValueOnce({}); // COMMIT

            // User is raterId 1, target is 2
            const res = await request(app)
                .put('/api/loads/20/rate')
                .send({ rating: 4, review: 'Updated review.' }); // New rating is 4 stars

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Rating updated successfully!');
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
            expect(redisClient.del).toHaveBeenCalledWith('user:2:reviews:page:1:limit:5');
            
            // Verify the recalculation query was called with the old and new ratings
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE users SET rating = $1 WHERE id = $2'),
                [4.0, 2]
            );
        });

        it('should return 404 if the rating to update is not found', async () => {
            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // No rating found
            mockClient.query.mockResolvedValueOnce({}); // ROLLBACK

            const res = await request(app)
                .put('/api/loads/20/rate')
                .send({ rating: 4 });

            expect(res.statusCode).toBe(404);
            expect(res.body.message).toBe('Rating not found.');
        });
    });

    describe('DELETE /:id/rate', () => {
        it('should successfully delete a rating and update user average', async () => {
            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            mockClient.query.mockResolvedValueOnce({ rows: [{ target_id: 2, rating: 5 }] }); // Find rating to delete
            mockClient.query.mockResolvedValueOnce({ rows: [{ rating: '4.0', rating_count: 2 }] }); // Get user stats
            mockClient.query.mockResolvedValueOnce({}); // DELETE from load_ratings
            mockClient.query.mockResolvedValueOnce({}); // UPDATE users
            mockClient.query.mockResolvedValueOnce({}); // COMMIT

            const res = await request(app).delete('/api/loads/20/rate');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Rating deleted successfully!');
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
            expect(redisClient.del).toHaveBeenCalledWith('user:2:reviews:page:1:limit:5');
        });

        it('should correctly reset rating to 0 when the last rating is deleted', async () => {
            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            mockClient.query.mockResolvedValueOnce({ rows: [{ target_id: 2, rating: 5 }] });
            mockClient.query.mockResolvedValueOnce({ rows: [{ rating: '5.0', rating_count: 1 }] }); // This is the last rating
            mockClient.query.mockResolvedValueOnce({}); // DELETE
            mockClient.query.mockResolvedValueOnce({}); // UPDATE users
            mockClient.query.mockResolvedValueOnce({}); // COMMIT

            await request(app).delete('/api/loads/20/rate');

            // Verify the CASE statement logic was used
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE users SET rating = $1, rating_count = $2'),
                [0, 0, 2]
            );
        });

        it('should return 404 if the rating to delete is not found', async () => {
            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // No rating found
            mockClient.query.mockResolvedValueOnce({}); // ROLLBACK

            const res = await request(app).delete('/api/loads/999/rate');

            expect(res.statusCode).toBe(404);
            expect(res.body.message).toBe('Rating not found.');
        });
    });
});

describe('Loads API - Driver Status Updates', () => {
    const sendEmail = require('./email');

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    describe('PATCH /:id/start-trip', () => {
        it('should update status to en_route and notify shipper', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ title: 'Test Load', owner_id: 2 }] }); // UPDATE load
            pool.query.mockResolvedValueOnce({ rows: [{ email: 'shipper@test.com', name: 'Shipper' }] }); // SELECT shipper

            const res = await request(app).patch('/api/loads/15/start-trip');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Trip started successfully and shipper notified.');
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE loads SET status = 'en_route'"), [1, '15']);
            expect(sendEmail).toHaveBeenCalledTimes(1);
            expect(sendEmail.mock.calls[0][0].to).toBe('shipper@test.com');
        });

        it('should return 404 if the load is not found', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE returns no rows
            const res = await request(app).patch('/api/loads/999/start-trip');
            expect(res.statusCode).toBe(404);
        });
    });

    describe('PATCH /:id/undo-start-trip', () => {
        it('should revert status to assigned for the correct driver', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ title: 'Test Load', owner_id: 2 }] });

            const res = await request(app).patch('/api/loads/15/undo-start-trip');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Trip start undone successfully.');
            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining("UPDATE loads SET status = 'assigned' WHERE id = $1 AND driver_id = $2 AND status = 'en_route'"),
                ['15', 1]
            );
        });

        it('should return 400 if the trip is not in the correct state to be undone', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app).patch('/api/loads/15/undo-start-trip');
            expect(res.statusCode).toBe(400);
        });
    });

    describe('PATCH /:id/arrived', () => {
        it('should update status to arrived', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ title: 'Test Load' }] });

            const res = await request(app).patch('/api/loads/15/arrived');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Status updated to Arrived.');
            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining("UPDATE loads SET status = 'arrived', arrived_at = NOW()"),
                ['15', 1]
            );
        });

        it('should return 400 if the load is not en_route', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app).patch('/api/loads/15/arrived');
            expect(res.statusCode).toBe(400);
        });
    });

    describe('PATCH /:id/completed-loading', () => {
        it('should update status to loading_completed', async () => {
            // Mock the update query to return a row, indicating success
            pool.query.mockResolvedValueOnce({ rows: [{ title: 'Test Load' }] });

            const res = await request(app).patch('/api/loads/15/completed-loading');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Status updated to Loading Completed.');
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status = 'loading_completed'"), ['15', 1]);
        });
    });
});

describe('Loads API - BOL Document Management', () => {
    const sendEmail = require('./email');


    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    describe('GET /:id/bol', () => {
        it('should return 404 if load is not found', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app).get('/api/loads/10/bol');
            expect(res.statusCode).toBe(404);
        });

        it('should return 403 if user is not authorized to view the BOL', async () => {
            // Mock load where the current user (ID 1) is neither the owner nor the driver
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 2, driver_id: 3, bol_url: 'url' }] });
            const res = await request(app).get('/api/loads/10/bol');
            expect(res.statusCode).toBe(403);
        });

        it('should return 404 if no BOL is attached', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 1, driver_id: 3, bol_url: null }] });
            const res = await request(app).get('/api/loads/10/bol');
            expect(res.statusCode).toBe(404);
        });

        it('should securely stream the BOL document from S3', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 1, driver_id: 3, bol_url: 'https://mock-bucket.s3.amazonaws.com/loads/bols/bol.pdf', title: 'Test Load' }] });
            const { getObjectStream } = require('./s3');

            const mockStream = {
                pipe: jest.fn((res) => {
                    res.end('PDF Content');
                })
            };
            getObjectStream.mockResolvedValueOnce({ stream: mockStream, contentType: 'application/pdf' });

            const res = await request(app).get('/api/loads/10/bol');

            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toBe('application/pdf');
            expect(res.headers['content-disposition']).toBe('attachment; filename="BOL_test_load.pdf"');
            expect(res.text).toBe('PDF Content');
        });
    });

    describe('POST /:id/signed-bol', () => {
        it('should successfully upload a signed BOL, update DB, and notify shipper', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 2, title: 'Signed BOL Load' }] }); // SELECT load by driver
            pool.query.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE loads
            pool.query.mockResolvedValueOnce({ rows: [{ email: 'shipper@test.com', name: 'Shipper' }] }); // SELECT shipper email

            const res = await request(app).post('/api/loads/10/signed-bol').send();

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Signed BOL uploaded successfully!');
            
            expect(pool.query).toHaveBeenCalledWith('UPDATE loads SET signed_bol_url = $1 WHERE id = $2', ['https://mock-bucket.s3.amazonaws.com/loads/bols/mock-bol.pdf', '10']);
            expect(sendEmail).toHaveBeenCalledTimes(1);
            expect(sendEmail.mock.calls[0][0].to).toBe('shipper@test.com');
        });

        it('should return 400 if no document is uploaded', async () => {
            const res = await request(app).post('/api/loads/10/signed-bol').set('x-no-file', 'true');
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toBe('No document uploaded. Please attach a signed BOL.');
        });
    });

    describe('GET /:id/signed-bol', () => {
        it('should securely stream the signed BOL document from S3', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 2, driver_id: 1, signed_bol_url: 'https://mock-bucket.s3.amazonaws.com/loads/bols/signed-bol.pdf', title: 'Signed Test Load' }] });
            const { getObjectStream } = require('./s3');
            const mockStream = { pipe: jest.fn((res) => { res.end('Signed PDF Content'); }) };
            getObjectStream.mockResolvedValueOnce({ stream: mockStream, contentType: 'application/pdf' });

            const res = await request(app).get('/api/loads/10/signed-bol');
            expect(res.statusCode).toBe(200);
            expect(res.text).toBe('Signed PDF Content');
        });
    });
});