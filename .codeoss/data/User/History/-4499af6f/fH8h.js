const request = require('supertest');
const express = require('express');
const pool = require('./db');
const multer = require('multer');

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
}));
jest.mock('./email', () => jest.fn(() => Promise.resolve()));

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(() => ({ send: mockS3Send })),
    GetObjectCommand: jest.fn((args) => ({ type: 'GetObject', args })),
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

// 5. Mock Mapbox Geocoding Service
const mockGeocodeSend = jest.fn();
jest.mock('@mapbox/mapbox-sdk/services/geocoding', () => jest.fn(() => ({
    forwardGeocode: jest.fn(() => ({
        send: mockGeocodeSend
    }))
})));

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

        // Default setup: Mapbox successfully finds coordinates
        mockGeocodeSend.mockResolvedValue({
            body: { features: [{ center: [-74.0060, 40.7128] }] }
        });
    });

    it('should successfully post a new load and attach geocoded coordinates', async () => {
        // 1. Mock DB returning no suspended companies for the user
        pool.query.mockResolvedValueOnce({ rows: [] });
        
        // 2. Mock DB returning the newly inserted load
        const mockNewLoad = { id: 10, title: 'Test Machinery Load', pickup_lng: -74.0060, pickup_lat: 40.7128 };
        pool.query.mockResolvedValueOnce({ rows: [mockNewLoad] });

        const res = await request(app)
            .post('/api/loads/post')
            .send({
                title: 'Test Machinery Load',
                pickupAddress: 'New York, NY',
                deliveryAddress: 'Los Angeles, CA'
            });

        expect(res.statusCode).toBe(201);
        expect(res.body.message).toBe('Load posted successfully!');
        expect(res.body.data).toEqual(mockNewLoad);
        
        // Verify the suspension check query was executed first
        expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining('SELECT id FROM companies WHERE owner_id = $1 AND is_suspended = true LIMIT 1'), [1]);
        // Verify the insert query was executed second
        expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO loads'), expect.any(Array));
    });

    it('should return 403 if the user owns a suspended company', async () => {
        // Mock DB returning a suspended company record
        pool.query.mockResolvedValueOnce({ rows: [{ id: 5 }] }); 

        const res = await request(app)
            .post('/api/loads/post')
            .send({ title: 'Test Load', pickupAddress: 'NY', deliveryAddress: 'LA' });

        expect(res.statusCode).toBe(403);
        expect(res.body.message).toBe('Cannot post load: Your company account is suspended.');
        expect(pool.query).toHaveBeenCalledTimes(1); // Should halt before the insert
    });

    it('should return 400 if geocoding fails to find the pickup coordinates', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }); // User is not suspended
        
        // Mock Mapbox returning no features
        mockGeocodeSend.mockResolvedValueOnce({ body: { features: [] } });

        const res = await request(app)
            .post('/api/loads/post')
            .send({ title: 'Test Load', pickupAddress: 'Nowhere', deliveryAddress: 'LA' });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Could not find coordinates for the specified pickup address.');
    });
});

describe('Loads API - POST /find', () => {
    const redisClient = require('./redis');

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should return cached data from Redis if available', async () => {
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
        redisClient.get.mockResolvedValueOnce(null); // Cache miss

        const mockCountRows = [{ count: '1' }];
        const mockLoadRows = [{ id: 2, title: 'DB Load', pickup_date: '2023-10-25' }];

        pool.query.mockResolvedValueOnce({ rows: mockCountRows }); // COUNT query
        pool.query.mockResolvedValueOnce({ rows: mockLoadRows });  // SELECT query

        const res = await request(app)
            .post('/api/loads/find')
            .send({
                startDate: '2023-10-20',
                'backhaul-origin': 'Chicago'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual(mockLoadRows);
        
        // Verify DB was called with filters
        expect(pool.query).toHaveBeenCalledTimes(2);
        
        // Verify Redis SET was called
        expect(redisClient.setEx).toHaveBeenCalledTimes(1);
        expect(redisClient.setEx).toHaveBeenCalledWith(
            expect.stringContaining('loads:find:'),
            60,
            expect.any(String)
        );
    });

    it('should gracefully fall back to the database if Redis GET fails', async () => {
        redisClient.get.mockRejectedValueOnce(new Error('Redis connection lost'));

        pool.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app).post('/api/loads/find').send({});

        expect(res.statusCode).toBe(200);
        expect(pool.query).toHaveBeenCalledTimes(2); // Still queries DB
    });
});

describe('Loads API - Interaction Endpoints', () => {
    let mockClient;
    const sendEmail = require('./email');

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Setup mock client for transaction-based endpoints like /accept
        mockClient = {
            query: jest.fn(),
            release: jest.fn(),
        };
        pool.connect.mockResolvedValue(mockClient);
    });

    describe('PATCH /:id/accept', () => {
        it('should successfully accept a load, commit transaction, and send emails', async () => {
            // Mock DB: 1. Check for active loads (none)
            mockClient.query.mockResolvedValueOnce({ rows: [] });
            // Mock DB: 2. Update load status (success)
            const mockAcceptedLoad = { title: 'New Load', owner_id: 2, accepted_at: new Date().toISOString() };
            mockClient.query.mockResolvedValueOnce({ rows: [mockAcceptedLoad] });
            // Mock DB: 3. Fetch shipper info
            mockClient.query.mockResolvedValueOnce({ rows: [{ email: 'shipper@test.com', name: 'Shipper' }] });
            // Mock DB: 4. Fetch driver info
            mockClient.query.mockResolvedValueOnce({ rows: [{ email: 'driver@test.com', name: 'Driver' }] });

            const res = await request(app).patch('/api/loads/10/accept');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Load accepted successfully!');
            
            // Verify transaction flow
            expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
            expect(mockClient.query).toHaveBeenCalledWith("SELECT id FROM loads WHERE driver_id = $1 AND status IN ('assigned', 'en_route', 'arrived', 'loading_completed')", [1]);
            expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE loads SET status = 'assigned'"), [1, '10']);
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
            expect(mockClient.release).toHaveBeenCalledTimes(1);

            // Verify emails were sent to both parties
            expect(sendEmail).toHaveBeenCalledTimes(2);
            expect(sendEmail.mock.calls[0][0].to).toBe('shipper@test.com');
            expect(sendEmail.mock.calls[1][0].to).toBe('driver@test.com');
        });

        it('should return 409 if the driver already has an active load', async () => {
            // Mock DB: 1. Check for active loads (found one)
            mockClient.query.mockResolvedValueOnce({ rows: [{ id: 99 }] });

            const res = await request(app).patch('/api/loads/10/accept');

            expect(res.statusCode).toBe(409);
            expect(res.body.message).toBe('You cannot accept a new load while you have another active trip.');
            
            // Verify transaction was rolled back
            expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });

        it('should return 400 if the load is no longer available', async () => {
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // Driver is free
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // Update returns no rows

            const res = await request(app).patch('/api/loads/10/accept');

            expect(res.statusCode).toBe(400);
            expect(res.body.message).toBe('Load is no longer available or has already been accepted.');
            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
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
            
            const mockStream = {
                pipe: jest.fn((res) => {
                    res.end('PDF Content');
                })
            };
            mockS3Send.mockResolvedValueOnce({ ContentType: 'application/pdf', Body: mockStream });

            const res = await request(app).get('/api/loads/10/bol');

            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toBe('application/pdf');
            expect(res.headers['content-disposition']).toBe('attachment; filename="BOL_test_load.pdf"');
            expect(res.text).toBe('PDF Content');
        });
    });

    describe('POST /:id/signed-bol', () => {
        it('should successfully upload a signed BOL, update DB, and notify shipper', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 2, title: 'Signed BOL Load' }] }); // SELECT load
            pool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE loads
            pool.query.mockResolvedValueOnce({ rows: [{ email: 'shipper@test.com', name: 'Shipper' }] }); // SELECT shipper email

            const res = await request(app).post('/api/loads/10/signed-bol');

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
            const mockStream = { pipe: jest.fn((res) => { res.end('Signed PDF Content'); }) };
            mockS3Send.mockResolvedValueOnce({ ContentType: 'application/pdf', Body: mockStream });

            const res = await request(app).get('/api/loads/10/signed-bol');
            expect(res.statusCode).toBe(200);
            expect(res.text).toBe('Signed PDF Content');
        });
    });
});