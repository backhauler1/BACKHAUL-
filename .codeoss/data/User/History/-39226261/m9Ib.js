const request = require('supertest');
const express = require('express');
const pool = require('../db');
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
jest.mock('multer', () => {
    const multer = () => ({
        single: () => (req, res, next) => {
            req.file = {
                location: 'https://mock-bucket.s3.amazonaws.com/companies/thumbnails/mock-image.jpg',
                mimetype: 'image/jpeg',
                size: 1024,
            };
            next();
        },
    });
    multer.MulterError = class MulterError extends Error {
jest.mock('multer');
const mockSingle = jest.fn();
multer.mockReturnValue({ single: mockSingle });
multer.MulterError = class MulterError extends Error {
        constructor(code) {
            super(code);
            this.code = code;
        }
    };
    return multer;
});
};

// 5. Mock Mapbox Geocoding
jest.mock('@mapbox/mapbox-sdk/services/geocoding', () => jest.fn(() => ({
    forwardGeocode: jest.fn().mockReturnThis(),
    send: jest.fn().mockResolvedValue({
        body: {
            features: [{
                center: [-74.0060, 40.7128]
            }]
        }
    })
})));

const companiesRouter = require('./companies');
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
        // Mock the check for suspended companies first
        pool.query.mockResolvedValueOnce({ rows: [] });
        pool.query.mockResolvedValueOnce({ rows: [mockNewCompany] });

        const res = await request(app)
            .post('/api/companies/register')
            .field('companyName', 'Test Company')
            .field('description', 'A mock company description.')
            .field('location', 'New York, NY'); // simulate form-data fields
            .field('location', 'New York, NY')
            .field('privacyPolicy', 'on'); // This field is required by the schema

        expect(res.statusCode).toBe(201);
        expect(res.body.message).toBe('Company registered successfully!');
        expect(res.body.data.thumbnail_url).toBe('https://mock-bucket.s3.amazonaws.com/companies/thumbnails/mock-image.jpg');
        expect(pool.query).toHaveBeenCalledTimes(1);
        expect(pool.query).toHaveBeenCalledTimes(2);
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