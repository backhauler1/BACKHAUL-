const request = require('supertest');
const app = require('../server');
const { protect } = require('../auth');
const jwt = require('jsonwebtoken');

// Mock middleware that would interfere with testing.
// We are telling Jest to replace the actual 'validateCsrf' with a function
// that just calls next(), effectively disabling it for our tests.
jest.mock('../csrf', () => ({
    validateCsrf: (req, res, next) => next(),
}));

// We also need to mock the database interactions to avoid hitting a real DB.
const pool = require('../db');
jest.mock('../db', () => ({
    query: jest.fn(),
}));

// Mock the Redis client to prevent real connections and allow testing cache interactions
const redisClient = require('../redis');
jest.mock('../redis', () => ({
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
    sendCommand: jest.fn().mockResolvedValue(),
    connect: jest.fn(),
}));

// bcrypt is slow, so we can mock it to speed up tests.
const bcrypt = require('bcrypt');
jest.mock('bcrypt', () => ({
    ...jest.requireActual('bcrypt'), // import and retain default behavior
    hash: jest.fn().mockResolvedValue('hashed_password_for_test'), // Mock the hash function
}));

// Before each test, clear any previous mock implementations and return values.
beforeEach(() => {
    pool.query.mockClear();
    bcrypt.hash.mockClear();
    
    redisClient.get.mockClear();
    redisClient.setEx.mockClear();
    redisClient.del.mockClear();
    redisClient.sendCommand.mockClear();
});

describe('Auth API Endpoints', () => {
    describe('POST /api/auth/register', () => {
        it('should return 400 when name, email, or password are not provided', async () => {
            const res = await request(app)
                .post('/api/auth/register')
                .send({
                    name: 'Test User',
                });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toHaveProperty('message', 'Name, email, and password are required.');
        });

        it('should return 400 when password is less than 8 characters', async () => {
            const res = await request(app)
                .post('/api/auth/register')
                .send({
                    name: 'Test User',
                    email: 'test@example.com',
                    password: '123',
                });
            expect(res.statusCode).toEqual(400);
            expect(res.body).toHaveProperty('message', 'Password must be at least 8 characters long.');
        });

        it('should return 409 if an account with the email already exists', async () => {
            // Simulate the DB finding an existing user
            pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

            const res = await request(app)
                .post('/api/auth/register')
                .send({
                    name: 'Test User',
                    email: 'exists@example.com',
                    password: 'password123',
                });

            expect(res.statusCode).toEqual(409);
            expect(res.body).toHaveProperty('message', 'An account with this email already exists.');
            expect(pool.query).toHaveBeenCalledWith('SELECT id FROM users WHERE email = $1', ['exists@example.com']);
        });

        it('should return 201 on successful registration', async () => {
            // Mock the DB calls: 1. Check for existing user (none), 2. Insert new user.
            pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 1, name: 'New User', email: 'new@example.com', roles: ['user'] }] });

            const res = await request(app)
                .post('/api/auth/register')
                .send({
                    name: 'New User',
                    email: 'new@example.com',
                    password: 'a_valid_password',
                });

            expect(res.statusCode).toEqual(201);
            expect(res.body).toHaveProperty('message', 'User registered successfully. Please log in.');
        });
    });

    describe('protect Middleware - Redis Caching', () => {
        let req, res, next;

        beforeEach(() => {
            req = { cookies: { token: 'mock_token' } };
            res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn(),
            };
            next = jest.fn();
        });

        afterEach(() => {
            jest.restoreAllMocks(); // Clean up jwt.verify spy after each test
        });

        it('should hit Redis cache and skip DB query when token version is cached', async () => {
            jest.spyOn(jwt, 'verify').mockReturnValue({ id: 1, roles: ['user'], tokenVersion: 2 });
            
            // Simulate a cache hit by returning the expected version string
            redisClient.get.mockResolvedValueOnce('2');

            await protect(req, res, next);

            expect(redisClient.get).toHaveBeenCalledWith('user:1:token_version');
            expect(pool.query).not.toHaveBeenCalled(); // Verify the database was skipped
            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user).toEqual({ id: 1, roles: ['user'] });
        });

        it('should query the database and update cache when Redis cache misses', async () => {
            jest.spyOn(jwt, 'verify').mockReturnValue({ id: 1, roles: ['user'], tokenVersion: 2 });
            
            // Simulate a cache miss
            redisClient.get.mockResolvedValueOnce(null);
            
            // Mock the fallback database response
            pool.query.mockResolvedValueOnce({ rows: [{ token_version: 2 }] });

            await protect(req, res, next);

            expect(pool.query).toHaveBeenCalledWith('SELECT token_version FROM users WHERE id = $1', [1]);
            expect(redisClient.setEx).toHaveBeenCalledWith('user:1:token_version', 3600, '2'); // Verify cache is populated
            expect(next).toHaveBeenCalledTimes(1);
        });

        it('should return 401 when the token is expired or invalid', async () => {
            // Simulate jwt.verify throwing an error (e.g., TokenExpiredError)
            jest.spyOn(jwt, 'verify').mockImplementation(() => {
                throw new Error('jwt expired');
            });

            await protect(req, res, next);

            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ message: 'Not authorized, token failed.' });
            expect(next).not.toHaveBeenCalled();
        });
    });
});