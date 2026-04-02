const request = require('supertest');
const express = require('express');
const pool = require('../db');
const { geocodeAddress } = require('../geocodingService');
const { S3Client } = require('@aws-sdk/client-s3');
const multer = require('multer');

// 1. Mock Database
jest.mock('../db', () => ({
    query: jest.fn(),
    connect: jest.fn(), // Also mock connect for transaction-based routes
}));

// 2. Mock Authentication and Rate Limiting Middleware
jest.mock('../middleware/auth', () => ({
    protect: (req, res, next) => {
        req.user = { id: 1, roles: ['admin'] };
        next();
    },
    authorize: () => (req, res, next) => next(),
}));
jest.mock('../rateLimiter', () => ({
    uploadLimiter: (req, res, next) => next(),
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
// By mocking multer, we can bypass the actual file upload logic and manually attach a mock file to the request.
jest.mock('multer-s3', () => jest.fn(() => 'mock-s3-storage'));
jest.mock('multer');
const mockSingle = jest.fn();
multer.mockReturnValue({ single: mockSingle });
multer.MulterError = class MulterError extends Error {
        constructor(code) {
            super(code);
            this.code = code;
        }
};

// 5. Mock the resilient geocoding service
jest.mock('../geocodingService', () => ({
    geocodeAddress: jest.fn(),
}));

const companiesRouter = require('../companies');
const app = express();
app.use(express.json());
app.use('/api/companies', companiesRouter);

describe('Companies API - Upload Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default mock for a successful upload
        mockSingle.mockImplementation(() => (req, res, next) => {
            if (req.headers['x-no-file']) {
                next();
            } else {
                req.file = {
                    location: 'https://mock-bucket.s3.amazonaws.com/companies/thumbnails/mock-image.jpg',
                    mimetype: 'image/jpeg',
                    size: 1024,
                };
                next();
            }
        });
    });

    it('should successfully register a company and mock the S3 file upload', async () => {
        const mockNewCompany = { id: 1, name: 'Test Company', thumbnail_url: 'https://mock-bucket.s3.amazonaws.com/companies/thumbnails/mock-image.jpg' };
        geocodeAddress.mockResolvedValue([-74.0060, 40.7128]); // Mock successful geocoding
        pool.query.mockResolvedValue({ rows: [mockNewCompany] });

        const res = await request(app)
            .post('/api/companies/register')
            .field('companyName', 'Test Company')
            .field('description', 'A mock company description.')
            .field('location', 'New York, NY')
            .field('privacyPolicy', 'on'); // This field is required by the schema

        expect(res.statusCode).toBe(201);
        expect(res.body.message).toBe('Company registered successfully!');
        expect(res.body.data.thumbnail_url).toBe('https://mock-bucket.s3.amazonaws.com/companies/thumbnails/mock-image.jpg');
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO companies (name, description, location, thumbnail_url, owner_id, location_lng, location_lat)'),
            ['Test Company', 'A mock company description.', 'New York, NY', 'https://mock-bucket.s3.amazonaws.com/companies/thumbnails/mock-image.jpg', 1, -74.0060, 40.7128]
        );
    });
});

describe('Companies API - PUT /:id', () => {
    it('should update a company and delete the old thumbnail when a new one is uploaded', async () => {
        // 1. Mock DB query to get the existing company with an old thumbnail
        pool.query.mockResolvedValueOnce({
            rows: [{
                owner_id: 1, // The mock user's ID
                thumbnail_url: 'https://mock-bucket.s3.amazonaws.com/companies/thumbnails/old-image.jpg'
            }]
        });
        // 2. Mock S3 deletion (this is the send call for DeleteObjectCommand)
        mockS3Send.mockResolvedValueOnce({});
        // 3. Mock DB query for the final UPDATE, returning the updated row
        const updatedCompany = { id: 15, name: 'Updated Company Name', thumbnail_url: 'https://mock-bucket.s3.amazonaws.com/companies/thumbnails/mock-image.jpg' };
        pool.query.mockResolvedValueOnce({ rows: [updatedCompany] });

        const res = await request(app)
            .put('/api/companies/15')
            .field('companyName', 'Updated Company Name')
            .field('privacyPolicy', 'on'); // Required field

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual(updatedCompany);
        
        // Verify the old thumbnail was deleted from S3
        expect(mockS3Send).toHaveBeenCalledTimes(1);
        const deleteCallArg = mockS3Send.mock.calls[0][0];
        expect(deleteCallArg.type).toBe('DeleteObject');
        expect(deleteCallArg.args.Key).toBe('companies/thumbnails/old-image.jpg');

        // Verify the DB was updated
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE companies'),
            expect.arrayContaining(['Updated Company Name', 'https://mock-bucket.s3.amazonaws.com/companies/thumbnails/mock-image.jpg', '15'])
        );
    });

    it('should return 403 if the user is not the owner or an admin', async () => {
        // Mock DB query to return a company owned by someone else
        pool.query.mockResolvedValueOnce({
            rows: [{
                owner_id: 99, // Different from the mock user's ID of 1
                thumbnail_url: null
            }]
        });

        const res = await request(app)
            .put('/api/companies/15')
            .field('companyName', 'Updated Company Name')
            .field('privacyPolicy', 'on');

        expect(res.statusCode).toBe(403);
        expect(res.body.message).toBe('Not authorized to update this company.');
    });

    it('should return 404 if the company does not exist', async () => {
        // Mock DB query to find no company
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app).put('/api/companies/999').field('companyName', 'Updated Company Name').field('privacyPolicy', 'on');
        expect(res.statusCode).toBe(404);
    });
});

describe('Companies API - DELETE /:id', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Suppress console output for error tests
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Setup mock client for transactions
        mockClient = {
            query: jest.fn(),
            release: jest.fn(),
        };
        pool.connect.mockResolvedValue(mockClient);
    });

    it('should delete a company and its thumbnail in a transaction', async () => {
        // Mock finding the company with a thumbnail
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({
            rows: [{ thumbnail_url: 'https://mock-bucket.s3.amazonaws.com/companies/thumbnails/to-delete.jpg' }]
        }); // SELECT
        mockS3Send.mockResolvedValueOnce({}); // S3 delete
        mockClient.query.mockResolvedValueOnce({ rowCount: 1 }); // DELETE
        mockClient.query.mockResolvedValueOnce({}); // COMMIT

        const res = await request(app).delete('/api/companies/5');

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Company ID 5 and associated thumbnail deleted successfully.');
        
        // Verify transaction steps
        expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
        expect(mockClient.query).toHaveBeenNthCalledWith(2, 'SELECT thumbnail_url FROM companies WHERE id = $1', ['5']);
        expect(mockClient.query).toHaveBeenNthCalledWith(3, 'DELETE FROM companies WHERE id = $1', ['5']);
        expect(mockClient.query).toHaveBeenNthCalledWith(4, 'COMMIT');
        expect(mockClient.release).toHaveBeenCalledTimes(1);

        // Verify S3 deletion
        expect(mockS3Send).toHaveBeenCalledTimes(1);
        const deleteCallArg = mockS3Send.mock.calls[0][0];
        expect(deleteCallArg.type).toBe('DeleteObject');
        expect(deleteCallArg.args.Key).toBe('companies/thumbnails/to-delete.jpg');
    });

    it('should return 404 and rollback if company is not found', async () => {
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({ rows: [] }); // SELECT empty
        // mockClient.query.mockResolvedValueOnce({}); // ROLLBACK (called automatically in catch block, but here it's caught in if (!company))

        const res = await request(app).delete('/api/companies/999');

        expect(res.statusCode).toBe(404);
        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should return 409 if there is a foreign key constraint violation', async () => {
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({
            rows: [{ thumbnail_url: null }]
        }); // SELECT
        
        const fkError = new Error('Foreign key violation');
        fkError.code = '23503';
        mockClient.query.mockRejectedValueOnce(fkError); // DELETE throws

        const res = await request(app).delete('/api/companies/5');

        expect(res.statusCode).toBe(409);
        expect(res.body.message).toBe('Cannot delete company. It has associated records (e.g., loads) that must be removed first.');
        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
});

describe('Companies API - GET / (List Companies)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return a paginated list of companies using default page and limit', async () => {
        const mockCompanies = [
            { id: 1, name: 'Company A', owner_name: 'Alice' },
            { id: 2, name: 'Company B', owner_name: 'Bob' },
        ];
        // 1. Mock the COUNT query
        pool.query.mockResolvedValueOnce({ rows: [{ count: '2' }] });
        // 2. Mock the SELECT query
        pool.query.mockResolvedValueOnce({ rows: mockCompanies });

        const res = await request(app).get('/api/companies');

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual(mockCompanies);
        expect(res.body.pagination).toEqual({
            currentPage: 1,
            totalPages: 1,
            totalItems: 2,
        });

        // Verify the SELECT query used default limit (15) and offset (0)
        expect(pool.query).toHaveBeenNthCalledWith(2,
            expect.stringContaining('ORDER BY c.created_at DESC LIMIT $1 OFFSET $2'),
            [15, 0]
        );
    });

    it('should handle specific page and limit parameters', async () => {
        // 1. Mock the COUNT query
        pool.query.mockResolvedValueOnce({ rows: [{ count: '50' }] });
        // 2. Mock the SELECT query
        pool.query.mockResolvedValueOnce({ rows: [] }); // The actual rows don't matter for this test

        const res = await request(app).get('/api/companies?page=3&limit=10');

        expect(res.statusCode).toBe(200);
        expect(res.body.pagination).toEqual({
            currentPage: 3,
            totalPages: 5, // 50 items / 10 per page
            totalItems: 50,
        });

        // Verify the SELECT query used the correct limit and offset
        // offset = (3 - 1) * 10 = 20
        expect(pool.query).toHaveBeenNthCalledWith(2,
            expect.stringContaining('ORDER BY c.created_at DESC LIMIT $1 OFFSET $2'),
            [10, 20]
        );
    });

    it('should filter companies based on a search term', async () => {
        const mockFilteredCompanies = [{ id: 5, name: 'TestCo', owner_name: 'Tester' }];
        pool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
        pool.query.mockResolvedValueOnce({ rows: mockFilteredCompanies });

        const res = await request(app).get('/api/companies?search=TestCo');

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual(mockFilteredCompanies);
        expect(res.body.pagination.totalItems).toBe(1);

        expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE c.name ILIKE $1'), ['%TestCo%']);
        expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $2 OFFSET $3'), ['%TestCo%', 15, 0]);
    });
});

describe('Companies API - PATCH /:id/suspend', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should successfully suspend a company', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 5, name: 'Test Company', is_suspended: true }]
        });

        const res = await request(app)
            .patch('/api/companies/5/suspend')
            .send({ suspend: true });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Company successfully suspended.');
        expect(pool.query).toHaveBeenCalledWith(
            'UPDATE companies SET is_suspended = $1 WHERE id = $2 RETURNING id, name, is_suspended',
            [true, '5']
        );
    });

    it('should successfully unsuspend a company', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 5, name: 'Test Company', is_suspended: false }]
        });

        const res = await request(app)
            .patch('/api/companies/5/suspend')
            .send({ suspend: false });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe('Company successfully unsuspended.');
        expect(pool.query).toHaveBeenCalledWith(
            'UPDATE companies SET is_suspended = $1 WHERE id = $2 RETURNING id, name, is_suspended',
            [false, '5']
        );
    });

    it('should return 404 if the company is not found', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app)
            .patch('/api/companies/999/suspend')
            .send({ suspend: true });

        expect(res.statusCode).toBe(404);
        expect(res.body.message).toBe('Company not found.');
    });
});

describe('Companies API - POST /find (Public Search)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return a list of non-suspended companies when no search term is provided', async () => {
        const mockCompanies = [
            { id: 1, name: 'Company A', is_suspended: false },
            { id: 2, name: 'Company B', is_suspended: false },
        ];
        pool.query.mockResolvedValueOnce({ rows: mockCompanies });

        const res = await request(app)
            .post('/api/companies/find')
            .send({}); // No search term

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual(mockCompanies);
        
        // Verify the query correctly filters out suspended companies
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('WHERE is_suspended = false'),
            []
        );
    });

    it('should return filtered companies based on a search term and exclude suspended ones', async () => {
        const mockFilteredCompany = [{ id: 5, name: 'Searchable Co', is_suspended: false }];
        pool.query.mockResolvedValueOnce({ rows: mockFilteredCompany });

        const res = await request(app)
            .post('/api/companies/find')
            .send({ 'search-term': 'Searchable' });

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual(mockFilteredCompany);

        // Verify the query includes both the suspension filter and the search term
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('WHERE is_suspended = false AND name ILIKE $1'),
            ['%Searchable%']
        );
    });

    it('should return 500 if the database query fails', async () => {
        pool.query.mockRejectedValueOnce(new Error('DB connection lost'));
        jest.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console error for this test

        const res = await request(app).post('/api/companies/find').send({});
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('Internal server error while searching for companies.');
    });
});

describe('Companies API - Compliance Documents', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default mock for a successful upload
        mockSingle.mockImplementation(() => (req, res, next) => {
            if (req.headers['x-no-file']) {
                next();
            } else {
                req.file = {
                    location: 'https://mock-bucket.s3.amazonaws.com/companies/documents/mock-doc.pdf',
                    mimetype: 'application/pdf',
                    size: 1024,
                };
                next();
            }
        });
    });

    describe('POST /:id/documents', () => {
        it('should upload a document for an authorized user (owner)', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 1 }] }); // Company ownership check
            const mockDoc = { id: 1, company_id: 10, document_type: 'COI', file_url: 'https://mock-bucket.s3.amazonaws.com/companies/documents/mock-doc.pdf' };
            pool.query.mockResolvedValueOnce({ rows: [mockDoc] }); // Document insertion

            const res = await request(app)
                .post('/api/companies/10/documents')
                .field('documentType', 'COI');

            expect(res.statusCode).toBe(201);
            expect(res.body.message).toBe('Document uploaded successfully.');
            expect(res.body.data).toEqual(mockDoc);
        });

        it('should return 403 if user is not the owner or an admin', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 99 }] }); // User 1 is not owner 99
            const res = await request(app)
                .post('/api/companies/10/documents')
                .field('documentType', 'COI');
            expect(res.statusCode).toBe(403);
        });

        it('should return 400 if no file is uploaded', async () => {
            const res = await request(app)
                .post('/api/companies/10/documents')
                .set('x-no-file', 'true')
                .field('documentType', 'COI');
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toBe('No document file uploaded.');
        });
    });

    describe('GET /:id/documents', () => {
        it('should return a list of documents for a company', async () => {
            const mockDocs = [{ id: 1, document_type: 'COI' }, { id: 2, document_type: 'W9' }];
            pool.query.mockResolvedValueOnce({ rows: mockDocs });
            const res = await request(app).get('/api/companies/10/documents');
            expect(res.statusCode).toBe(200);
            expect(res.body.data).toEqual(mockDocs);
        });
    });

    describe('DELETE /:id/documents/:docId', () => {
        it('should delete a document and its S3 object for an authorized user', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ owner_id: 1 }] }); // Ownership check
            pool.query.mockResolvedValueOnce({ rows: [{ file_url: 'https://mock-bucket.s3.amazonaws.com/companies/documents/doc-to-delete.pdf' }] }); // Get file URL
            pool.query.mockResolvedValueOnce({ rowCount: 1 }); // DB delete
            mockS3Send.mockResolvedValueOnce({}); // S3 delete

            const res = await request(app).delete('/api/companies/10/documents/5');

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toBe('Document deleted successfully.');
            expect(mockS3Send).toHaveBeenCalledTimes(1);
            const deleteCallArg = mockS3Send.mock.calls[0][0];
            expect(deleteCallArg.type).toBe('DeleteObject');
            expect(deleteCallArg.args.Key).toBe('companies/documents/doc-to-delete.pdf');
        });
    });

    describe('PATCH /:id/documents/:docId/verify', () => {
        it('should allow an admin to verify a document', async () => {
            const mockUpdatedDoc = { id: 5, is_verified: true };
            pool.query.mockResolvedValueOnce({ rows: [mockUpdatedDoc] });

            const res = await request(app)
                .patch('/api/companies/10/documents/5/verify')
                .send({ is_verified: true });

            expect(res.statusCode).toBe(200);
            expect(res.body.data.is_verified).toBe(true);
        });

        it('should return 404 if document to verify is not found', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app)
                .patch('/api/companies/10/documents/99/verify')
                .send({ is_verified: true });
            expect(res.statusCode).toBe(404);
        });
    });
});

describe('Companies API - Multer Error Handling', () => {
    it('should return 400 if file is too large', async () => {
        // Configure the multer mock to throw a specific error
        mockSingle.mockImplementation(() => (req, res, next) => {
            const error = new multer.MulterError('LIMIT_FILE_SIZE');
            next(error);
        });

        const res = await request(app)
            .post('/api/companies/register')
            .field('companyName', 'Test Company')
            .field('privacyPolicy', 'on');

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('File is too large.');
    });

    it('should return 400 for an invalid file type', async () => {
        // Configure the multer mock to throw a specific error
        mockSingle.mockImplementation(() => (req, res, next) => {
            // The fileFilter in companies.js calls cb(new Error('INVALID_FILE_TYPE'))
            const error = new Error('INVALID_FILE_TYPE');
            next(error);
        });

        const res = await request(app)
            .post('/api/companies/register')
            .field('companyName', 'Test Company')
            .field('privacyPolicy', 'on');

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Invalid file format. Please upload a JPEG, PNG, GIF, or WebP.');
    });
});