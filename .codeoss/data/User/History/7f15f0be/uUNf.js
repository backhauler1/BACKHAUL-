const request = require('supertest');
const express = require('express');
const pool = require('./db');
const { geocodeAddress } = require('./geocodingService');
const { S3Client } = require('@aws-sdk/client-s3');
const multer = require('multer');

// 1. Mock Database
jest.mock('./db', () => ({
    query: jest.fn(),
    connect: jest.fn(),
}));

// 2. Mock Authentication and Rate Limiting Middleware
jest.mock('./auth', () => ({
    protect: (req, res, next) => {
        // For truck routes, let's assume a 'driver' role
        req.user = { id: 1, roles: ['driver'] };
        next();
    },
    authorize: () => (req, res, next) => next(),
}));
jest.mock('./rateLimiter', () => ({
    uploadLimiter: (req, res, next) => next(),
    searchLimiter: (req, res, next) => next(),
}));

// 3. Mock AWS SDK S3Client
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(() => ({
        send: mockS3Send,
    })),
    DeleteObjectCommand: jest.fn((args) => ({ type: 'DeleteObject', args })),
}));

// 4. Mock multer-s3 and multer
jest.mock('multer-s3', () => jest.fn(() => 'mock-s3-storage'));
jest.mock('multer');
const mockMiddleware = (req, res, next) => {
    req.file = {
        location: 'https://mock-bucket.s3.amazonaws.com/trucks/thumbnails/mock-truck.jpg',
    };
    next();
};
const mockSingle = jest.fn().mockReturnValue(mockMiddleware);
const mockNone = jest.fn().mockReturnValue((req, res, next) => next());

jest.mock('./uploads', () => ({
    uploadThumbnail: { single: mockSingle }
}), { virtual: true });

multer.mockReturnValue({ single: mockSingle, none: mockNone });
multer.MulterError = class MulterError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
};

// 5. Mock the resilient geocoding service
jest.mock('./geocodingService', () => ({
    geocodeAddress: jest.fn(),
}));

// 6. Mock Redis
jest.mock('./redis', () => ({
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue('OK'),
}));

const trucksRouter = require('./trucks');
const app = express();
app.use(express.json());
app.use('/api/trucks', trucksRouter);

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Trucks API', () => {
    describe('POST /register', () => {
        it('should successfully register a truck with a thumbnail', async () => {
            const mockNewTruck = { id: 1, name: 'My Big Rig', thumbnail_url: 'https://mock-bucket.s3.amazonaws.com/trucks/thumbnails/mock-truck.jpg' };
            geocodeAddress.mockResolvedValue([-118.2437, 34.0522]); // Mock successful geocoding
            pool.query.mockResolvedValueOnce({ rows: [mockNewTruck] });

            const res = await request(app)
                .post('/api/trucks/register')
                .send({
                    truckName: 'My Big Rig',
                    truckType: 'dry_van',
                    homeBase: 'Los Angeles, CA'
                });

            expect(res.statusCode).toBe(201);
            expect(res.body.message).toBe('Truck registered successfully!');
            expect(res.body.data).toEqual(mockNewTruck);
            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO trucks (name, type, capacity, home_base, thumbnail_url, owner_id, home_base_lng, home_base_lat)'),
                ['My Big Rig', 'dry_van', undefined, 'Los Angeles, CA', 'https://mock-bucket.s3.amazonaws.com/trucks/thumbnails/mock-truck.jpg', 1, -118.2437, 34.0522]
            );
        });
    });

    describe('GET /me', () => {
        it('should return a paginated list of trucks owned by the current user', async () => {
            const mockTrucks = [
                { id: 1, name: 'Truck 1', owner_id: 1 },
                { id: 2, name: 'Truck 2', owner_id: 1 }
            ];
            pool.query.mockResolvedValueOnce({ rows: [{ count: '2' }] }); // Count query mock
            pool.query.mockResolvedValueOnce({ rows: mockTrucks });

            const res = await request(app).get('/api/trucks/me?page=1&limit=15');

            expect(res.statusCode).toBe(200);
            expect(res.body.data).toEqual(mockTrucks);
            expect(res.body.pagination).toEqual({
                currentPage: 1,
                totalPages: 1,
                totalItems: 2
            });
            expect(pool.query).toHaveBeenCalledWith('SELECT COUNT(id) FROM trucks WHERE owner_id = $1', [1]);
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $2 OFFSET $3'), [1, 15, 0]);
        });
    });

    describe('PUT /:id', () => {
        it('should update a truck and delete the old thumbnail', async () => {
            pool.query.mockResolvedValueOnce({
                rows: [{
                    owner_id: 1, // Mock user's ID
                    thumbnail_url: 'https://mock-bucket.s3.amazonaws.com/trucks/thumbnails/old-truck.jpg'
                }]
            });
            mockS3Send.mockResolvedValueOnce({});
            const updatedTruck = { id: 22, name: 'Updated Rig', thumbnail_url: 'https://mock-bucket.s3.amazonaws.com/trucks/thumbnails/mock-truck.jpg' };
            pool.query.mockResolvedValueOnce({ rows: [updatedTruck] });

            const res = await request(app)
                .put('/api/trucks/22')
                .send({ truckName: 'Updated Rig', truckType: 'dry_van', homeBase: 'LA, CA', capacity: 1000 });

            expect(res.statusCode).toBe(200);
            expect(res.body.data).toEqual(updatedTruck);
            expect(mockS3Send).toHaveBeenCalledTimes(1);
            const deleteCallArg = mockS3Send.mock.calls[0][0];
            expect(deleteCallArg.args.Key).toBe('trucks/thumbnails/old-truck.jpg');
        });

        it('should return 403 if user is not the owner', async () => {
            pool.query.mockResolvedValueOnce({
                rows: [{ owner_id: 99 }] // Different owner
            });

            const res = await request(app)
                .put('/api/trucks/22')
                .send({ truckName: 'Updated Rig' });
            
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toBe('Not authorized to update this truck.');
        });
    });

    describe('DELETE /:id', () => {
        let mockClient;
        beforeEach(() => {
            mockClient = { query: jest.fn(), release: jest.fn() };
            pool.connect.mockResolvedValue(mockClient);
        });

        it('should delete a truck and its thumbnail', async () => {
            mockClient.query.mockResolvedValueOnce({}); // BEGIN
            mockClient.query.mockResolvedValueOnce({
                rows: [{ owner_id: 1, thumbnail_url: 'https://mock-bucket.s3.amazonaws.com/trucks/thumbnails/to-delete.jpg' }]
            }); // SELECT
            mockS3Send.mockResolvedValueOnce({}); // S3 delete
            mockClient.query.mockResolvedValueOnce({ rowCount: 1 }); // DELETE
            mockClient.query.mockResolvedValueOnce({}); // COMMIT

            const res = await request(app).delete('/api/trucks/5');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Truck ID 5 deleted successfully.');
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
            expect(mockS3Send).toHaveBeenCalledTimes(1);
        });
    });

    describe('PATCH /:id/availability', () => {
        it('should update truck availability', async () => {
            pool.query.mockResolvedValueOnce({
                rows: [{ id: 7, name: 'My Truck', is_available: true }]
            });

            const res = await request(app)
                .patch('/api/trucks/7/availability')
                .send({ isAvailable: true });

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Truck status updated to available.');
            expect(pool.query).toHaveBeenCalledWith(
                'UPDATE trucks SET is_available = $1 WHERE id = $2 AND owner_id = $3 RETURNING id, name, is_available',
                [true, '7', 1]
            );
        });
    });

    describe('POST /find', () => {
        it('should return a paginated list of available trucks', async () => {
            const mockTrucks = [{ id: 1, name: 'Available Truck' }];
            pool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // Count query
            pool.query.mockResolvedValueOnce({ rows: mockTrucks }); // Data query

            const res = await request(app)
                .post('/api/trucks/find?page=1&limit=10')
                .send({ truckType: 'dry_van' });

            expect(res.statusCode).toBe(200);
            expect(res.body.data).toEqual(mockTrucks);
            expect(res.body.pagination).toEqual({
                currentPage: 1,
                totalPages: 1,
                totalItems: 1,
            });
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE is_available = true AND type = $1'), expect.any(Array));
        });
    });
});