const request = require('supertest');
const express = require('express');
const pool = require('../db');
const { S3Client } = require('@aws-sdk/client-s3');

// 1. Mock Database
jest.mock('../db', () => ({
    query: jest.fn(),
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
        constructor(code) {
            super(code);
            this.code = code;
        }
    };
    return multer;
});

const companiesRouter = require('./companies');
const app = express();
app.use(express.json());
app.use('/api/companies', companiesRouter);

describe('Companies API - Upload Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should successfully register a company and mock the S3 file upload', async () => {
        const mockNewCompany = { id: 1, name: 'Test Company', thumbnail_url: 'https://mock-bucket.s3.amazonaws.com/companies/thumbnails/mock-image.jpg' };
        pool.query.mockResolvedValueOnce({ rows: [mockNewCompany] });

        const res = await request(app)
            .post('/api/companies/register')
            .field('companyName', 'Test Company')
            .field('description', 'A mock company description.')
            .field('location', 'New York, NY'); // simulate form-data fields

        expect(res.statusCode).toBe(201);
        expect(res.body.message).toBe('Company registered successfully!');
        expect(res.body.data.thumbnail_url).toBe('https://mock-bucket.s3.amazonaws.com/companies/thumbnails/mock-image.jpg');
        expect(pool.query).toHaveBeenCalledTimes(1);
    });
});