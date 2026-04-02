const { protect, authorize } = require('./auth');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const redisClient = require('./redis');

jest.mock('jsonwebtoken', () => ({
    verify: jest.fn(),
}));
jest.mock('./db', () => ({
    query: jest.fn(),
}));
jest.mock('./redis', () => ({
    get: jest.fn(),
    setEx: jest.fn(),
}));

describe('Auth Middleware (auth.js)', () => {
    let req, res, next;

    beforeEach(() => {
        jest.clearAllMocks();
        req = { cookies: {} };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };
        next = jest.fn();
        process.env.JWT_SECRET = 'test-secret';
    });

    describe('protect middleware', () => {
        it('should return 401 if no token is provided', async () => {
            await protect(req, res, next);
            
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ message: 'Not authorized, no token provided.' });
            expect(next).not.toHaveBeenCalled();
        });

        it('should return 401 if the JWT is invalid or expired', async () => {
            req.cookies.token = 'invalid-token';
            jwt.verify.mockImplementation(() => { throw new Error('jwt expired'); });

            await protect(req, res, next);

            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ message: 'Not authorized, token failed.' });
            expect(next).not.toHaveBeenCalled();
        });

        it('should call next() if token is valid and version matches Redis cache (Cache Hit)', async () => {
            req.cookies.token = 'valid-token';
            // Token version in JWT is 1
            jwt.verify.mockReturnValue({ id: 99, roles: ['user'], tokenVersion: 1 });
            // Token version in Redis is also 1
            redisClient.get.mockResolvedValueOnce('1');

            await protect(req, res, next);

            expect(redisClient.get).toHaveBeenCalledWith('user:99:token_version');
            expect(pool.query).not.toHaveBeenCalled(); // Should skip DB query
            expect(req.user).toEqual({ id: 99, roles: ['user'] });
            expect(next).toHaveBeenCalledTimes(1);
        });

        it('should query DB and call next() if Redis cache misses (Cache Miss)', async () => {
            req.cookies.token = 'valid-token';
            jwt.verify.mockReturnValue({ id: 99, roles: ['user'], tokenVersion: 2 });
            
            redisClient.get.mockResolvedValueOnce(null); // Cache miss
            pool.query.mockResolvedValueOnce({ rows: [{ token_version: 2 }] }); // DB hit matches version 2

            await protect(req, res, next);

            expect(pool.query).toHaveBeenCalledWith('SELECT token_version FROM users WHERE id = $1', [99]);
            expect(redisClient.setEx).toHaveBeenCalledWith('user:99:token_version', 3600, '2'); // Caches for next time
            expect(req.user).toEqual({ id: 99, roles: ['user'] });
            expect(next).toHaveBeenCalledTimes(1);
        });

        it('should return 401 if token version in JWT is older than the cache/DB version (Session Invalidated)', async () => {
            req.cookies.token = 'outdated-token';
            // Token was issued with version 0
            jwt.verify.mockReturnValue({ id: 99, roles: ['user'], tokenVersion: 0 });
            // User recently changed password, so DB version is now 1
            redisClient.get.mockResolvedValueOnce(null); 
            pool.query.mockResolvedValueOnce({ rows: [{ token_version: 1 }] }); 

            await protect(req, res, next);

            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ message: 'Session invalidated. Please log in again.' });
            expect(next).not.toHaveBeenCalled();
        });

        it('should return 401 if user no longer exists in DB on cache miss', async () => {
            req.cookies.token = 'valid-token';
            jwt.verify.mockReturnValue({ id: 99, roles: ['user'], tokenVersion: 0 });
            
            redisClient.get.mockResolvedValueOnce(null);
            pool.query.mockResolvedValueOnce({ rows: [] }); // User deleted

            await protect(req, res, next);

            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ message: 'Session invalidated. Please log in again.' });
        });
    });

    describe('authorize middleware', () => {
        it('should call next() if the user has the required role', () => {
            req.user = { id: 1, roles: ['admin', 'user'] };
            const middleware = authorize('admin');
            
            middleware(req, res, next);
            
            expect(next).toHaveBeenCalledTimes(1);
            expect(res.status).not.toHaveBeenCalled();
        });

        it('should return 403 if the user lacks the required role', () => {
            req.user = { id: 1, roles: ['user'] };
            const middleware = authorize('admin', 'moderator');
            
            middleware(req, res, next);
            
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith({ message: 'Forbidden. You do not have permission to perform this action.' });
            expect(next).not.toHaveBeenCalled();
        });
    });
});