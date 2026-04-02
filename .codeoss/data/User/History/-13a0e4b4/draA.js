const request = require('supertest');
const express = require('express');
const pool = require('./db');
const redisClient = require('./redis');
const sendEmail = require('./email');
const { Readable } = require('stream');

// 1. Mock dependencies
jest.mock('./db', () => ({
    query: jest.fn(),
    connect: jest.fn(),
}));

jest.mock('./redis', () => ({
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
}));

jest.mock('./email', () => jest.fn(() => Promise.resolve()));

// 2. Mock middleware
jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        // Mock an admin user for admin-only routes, and a regular user for public routes
        req.user = { id: 1, roles: ['admin'] };
        next();
    },
    authorize: (...roles) => (req, res, next) => {
        if (req.user && req.user.roles.some(userRole => roles.includes(userRole))) {
            next();
        } else {
            res.status(403).json({ message: 'Forbidden' });
        }
    },
}));

// 3. Setup Express app with the router
const usersRouter = require('./users');
const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);

describe('Users API - Admin Endpoints', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    describe('GET /api/users', () => {
        it('should return a paginated list of users', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ count: '2' }] }); // Count query
            const mockUsers = [{ id: 1, name: 'User A' }, { id: 2, name: 'User B' }];
            pool.query.mockResolvedValueOnce({ rows: mockUsers }); // Select query

            const res = await request(app).get('/api/users?page=1&limit=10');

            expect(res.statusCode).toBe(200);
            expect(res.body.data).toEqual(mockUsers);
            expect(res.body.pagination).toEqual({ currentPage: 1, totalPages: 1, totalItems: 2 });
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY penalty_count DESC'), [10, 0]);
        });

        it('should filter users by a search term', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
            pool.query.mockResolvedValueOnce({ rows: [{ id: 5, name: 'Searched User' }] });

            const res = await request(app).get('/api/users?search=Searched');

            expect(res.statusCode).toBe(200);
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE email ILIKE $1 OR name ILIKE $1'), ['%Searched%']);
        });

        it('should handle database errors gracefully', async () => {
            pool.query.mockRejectedValueOnce(new Error('DB connection failed'));
            const res = await request(app).get('/api/users');
            expect(res.statusCode).toBe(500);
            expect(res.body.message).toBe('Internal server error while fetching users.');
        });
    });

    describe('GET /api/users/admin/top-referrers', () => {
        it('should return a paginated list of top referrers', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ count: '2' }] }); // Count query
            const mockReferrers = [
                { id: 1, name: 'Alice', email: 'alice@test.com', total_referrals: 10 },
                { id: 2, name: 'Bob', email: 'bob@test.com', total_referrals: 5 }
            ];
            pool.query.mockResolvedValueOnce({ rows: mockReferrers }); // Select query

            const res = await request(app).get('/api/users/admin/top-referrers?page=1&limit=10');

            expect(res.statusCode).toBe(200);
            expect(res.body.data).toEqual(mockReferrers);
            expect(res.body.pagination).toEqual({ currentPage: 1, totalPages: 1, totalItems: 2 });
            
            // Verify queries executed
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('COUNT(DISTINCT r.referred_by_id)'));
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY total_referrals DESC'), [10, 0]);
        });
    });

    describe('PATCH /api/users/:id/suspend', () => {
        it('should suspend a user, invalidate session, and send an email', async () => {
            const mockUpdatedUser = { id: 5, name: 'Suspended User', email: 'suspended@test.com', is_suspended: true };
            pool.query.mockResolvedValueOnce({ rows: [mockUpdatedUser] });

            const res = await request(app)
                .patch('/api/users/5/suspend')
                .send({ suspend: true, reason: 'Testing suspension' });

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('User account has been suspended.');
            
            // Verify session invalidation logic
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('token_version = COALESCE(token_version, 0) + 1'), [5]);
            expect(redisClient.del).toHaveBeenCalledWith('user:5:token_version');

            // Verify email notification
            expect(sendEmail).toHaveBeenCalledTimes(1);
            const emailOptions = sendEmail.mock.calls[0][0];
            expect(emailOptions.to).toBe('suspended@test.com');
            expect(emailOptions.subject).toContain('Suspended');
            expect(emailOptions.text).toContain('Reason: Testing suspension');
        });

        it('should unsuspend a user and send an email', async () => {
            const mockUpdatedUser = { id: 8, name: 'Restored User', email: 'restored@test.com', is_suspended: false };
            pool.query.mockResolvedValueOnce({ rows: [mockUpdatedUser] });

            const res = await request(app)
                .patch('/api/users/8/suspend')
                .send({ suspend: false });

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('User account has been unsuspended.');
            expect(sendEmail).toHaveBeenCalledTimes(1);
            expect(sendEmail.mock.calls[0][0].subject).toContain('Restored');
        });

        it('should return 404 if user to suspend is not found', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app).patch('/api/users/999/suspend').send({ suspend: true });
            expect(res.statusCode).toBe(404);
            expect(res.body.message).toBe('User not found.');
        });
    });

    describe('POST /api/users/suspension-history/export', () => {
        let mockClient;

        beforeEach(() => {
            mockClient = {
                query: jest.fn(),
                release: jest.fn(),
            };
            pool.connect.mockResolvedValue(mockClient);
        });

        it('should successfully stream suspension history as a CSV file', async () => {
            const mockDbStream = new Readable({
                objectMode: true,
                read() {}
            });

            mockClient.query.mockReturnValue(mockDbStream);

            // Make the request first, as the streaming happens asynchronously
            const reqPromise = request(app)
                .post('/api/users/suspension-history/export')
                .send({ search: 'Bad Actor' });

            // Push data into the stream
            mockDbStream.push({
                created_at: '2023-10-01T12:00:00Z',
                target_user_name: 'Bad Actor',
                target_user_id: 10,
                admin_name: 'SuperAdmin',
                admin_id: 1,
                action: 'suspended',
                reason: 'Spamming'
            });
            mockDbStream.push(null);

            const res = await reqPromise;

            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.headers['content-disposition']).toBe('attachment; filename="suspension-history.csv"');
            expect(res.text).toContain('Date,Target User,Admin,Action,Reason');
            expect(res.text).toContain('Bad Actor (#10)');
            expect(res.text).toContain('SuperAdmin (#1)');
            expect(res.text).toContain('Spamming');
            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });

        it('should handle database streaming errors, release the client, and return 500', async () => {
            const mockDbStream = new Readable({
                objectMode: true,
                read() {}
            });

            mockClient.query.mockReturnValue(mockDbStream);

            // Simulate a database connection loss or query error during streaming
            process.nextTick(() => {
                mockDbStream.emit('error', new Error('Simulated Database Error'));
            });

            const res = await request(app).post('/api/users/suspension-history/export');

            expect(res.statusCode).toBe(500);
            expect(res.body.message).toBe('Error streaming data.');
            
            // Ensure the client was released even when an error occurred
            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });

        it('should handle pool.connect() failures gracefully', async () => {
            pool.connect.mockRejectedValueOnce(new Error('Pool exhausted'));

            const res = await request(app).post('/api/users/suspension-history/export');

            expect(res.statusCode).toBe(500);
            expect(res.body.message).toBe('Internal server error during CSV export.');
            expect(mockClient.release).not.toHaveBeenCalled();
        });
    });
});

describe('Users API - Public Endpoints', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    describe('GET /api/users/me/referrals', () => {
        it('should return the user referral code and total referred count', async () => {
            pool.query
                .mockResolvedValueOnce({ rows: [{ referral_code: 'REF123' }] })
                .mockResolvedValueOnce({ rows: [{ count: '5' }] });

            const res = await request(app).get('/api/users/me/referrals');

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ referralCode: 'REF123', totalReferred: 5 });
            expect(pool.query).toHaveBeenCalledWith('SELECT referral_code FROM users WHERE id = $1', [1]);
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('COUNT(DISTINCT r.id)'), [1]);
        });

        it('should return 404 if the user is not found', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] }); // User not found
            const res = await request(app).get('/api/users/me/referrals');
            expect(res.statusCode).toBe(404);
            expect(res.body.message).toBe('User not found.');
        });
    });

    describe('GET /api/users/:id/reviews', () => {
        it('should return cached reviews from Redis if available', async () => {
            const mockCachedData = { data: [{ review: 'Cached review' }], summary: {}, pagination: {} };
            redisClient.get.mockResolvedValueOnce(JSON.stringify(mockCachedData));

            const res = await request(app).get('/api/users/10/reviews');

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual(mockCachedData);
            expect(redisClient.get).toHaveBeenCalledWith('user:10:reviews:page:1:limit:15');
            expect(pool.query).not.toHaveBeenCalled();
        });

        it('should fetch from DB and cache the result on a Redis miss', async () => {
            redisClient.get.mockResolvedValueOnce(null); // Cache miss

            // Mock DB calls: 1. User summary, 2. Review count, 3. Review list
            pool.query.mockResolvedValueOnce({ rows: [{ rating: '4.5', rating_count: 10 }] });
            pool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
            pool.query.mockResolvedValueOnce({ rows: [{ review: 'DB review' }] });

            const res = await request(app).get('/api/users/10/reviews');

            expect(res.statusCode).toBe(200);
            expect(res.body.data[0].review).toBe('DB review');
            expect(res.body.summary.averageRating).toBe(4.5);
            expect(pool.query).toHaveBeenCalledTimes(3);
            expect(redisClient.setEx).toHaveBeenCalledWith('user:10:reviews:page:1:limit:15', 60, expect.any(String));
        });

        it('should return 404 if user is not found on a cache miss', async () => {
            redisClient.get.mockResolvedValueOnce(null);
            pool.query.mockResolvedValueOnce({ rows: [] }); // User query returns no rows

            const res = await request(app).get('/api/users/999/reviews');

            expect(res.statusCode).toBe(404);
            expect(res.body.message).toBe('User not found.');
        });
    });
});