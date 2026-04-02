const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('./db');
const registerRouter = require('./register');

// Mock dependencies
jest.mock('./db', () => ({
    query: jest.fn(),
}));
jest.mock('bcrypt', () => ({
    hash: jest.fn(),
}));
jest.mock('./rateLimiter', () => ({
    authLimiter: (req, res, next) => next(),
}));

const app = express();
app.use(express.json());
app.use('/api/auth', registerRouter);

describe('POST /api/auth/register', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should successfully register a new user', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [] }) // User check (none exists)
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Test User', email: 'test@example.com', roles: ['user'] }] }); // Insert new user
        
        bcrypt.hash.mockResolvedValueOnce('hashedpassword');

        const res = await request(app)
            .post('/api/auth/register')
            .send({ name: 'Test User', email: 'test@example.com', password: 'password123' });

        expect(res.statusCode).toBe(201);
        expect(res.body.message).toBe('User registered successfully. Please log in.');

        // Verify DB calls
        expect(pool.query).toHaveBeenCalledTimes(2);
        expect(pool.query).toHaveBeenNthCalledWith(1, 'SELECT id FROM users WHERE email = $1', ['test@example.com']);
        expect(pool.query).toHaveBeenNthCalledWith(
            2,
            'INSERT INTO users (name, email, password, roles) VALUES ($1, $2, $3, $4) RETURNING id, name, email, roles',
            ['Test User', 'test@example.com', 'hashedpassword', ['user']]
        );
    });

    it('should return 409 if the email already exists', async () => {
        pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // User already exists

        const res = await request(app)
            .post('/api/auth/register')
            .send({ name: 'Test User', email: 'existing@example.com', password: 'password123' });

        expect(res.statusCode).toBe(409);
        expect(res.body.message).toBe('An account with this email already exists.');
    });

    it('should return 400 if password is less than 8 characters', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ name: 'Test User', email: 'test@example.com', password: 'short' });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Password must be at least 8 characters long.');
    });

    it('should return 400 if fields are missing', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ email: 'test@example.com', password: 'password123' }); // Missing name

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Name is required.');
    });
});