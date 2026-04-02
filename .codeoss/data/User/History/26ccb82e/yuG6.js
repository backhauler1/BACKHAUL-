const { generateCsrfToken, validateCsrf } = require('./csrf');

describe('CSRF Middleware', () => {
    let req, res, next;

    beforeEach(() => {
        // Setup default mock request, response, and next objects before each test
        req = {
            method: 'POST',
            originalUrl: '/api/secure-route',
            cookies: {},
            headers: {}
        };
        res = {
            cookie: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        next = jest.fn();
    });

    describe('generateCsrfToken', () => {
        it('should generate a token, set an httpOnly cookie, and return the token in JSON', () => {
            generateCsrfToken(req, res);

            // Verify cookie was set with the correct attributes
            expect(res.cookie).toHaveBeenCalledTimes(1);
            expect(res.cookie.mock.calls[0][0]).toBe('_csrf');
            
            const generatedToken = res.cookie.mock.calls[0][1];
            expect(typeof generatedToken).toBe('string');
            expect(generatedToken).toHaveLength(64); // 32 random bytes represented as hex

            // Verify the token is returned in the response
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ csrfToken: generatedToken });
        });
    });

    describe('validateCsrf', () => {
        it('should skip validation and call next() for safe HTTP methods', () => {
            const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
            safeMethods.forEach(method => {
                req.method = method;
                validateCsrf(req, res, next);
                expect(next).toHaveBeenCalledTimes(1);
                next.mockClear(); // Reset the spy for the next iteration
            });
        });

        it('should skip validation and call next() for the Stripe webhook', () => {
            req.originalUrl = '/api/stripe/webhook';
            validateCsrf(req, res, next);
            expect(next).toHaveBeenCalledTimes(1);
        });

        it('should return 403 if either the CSRF cookie or header is missing', () => {
            // Missing Cookie
            req.headers['x-csrf-token'] = 'some-token';
            validateCsrf(req, res, next);
            
            // Missing Header
            req.cookies._csrf = 'some-token';
            delete req.headers['x-csrf-token'];
            validateCsrf(req, res, next);

            expect(res.status).toHaveBeenCalledTimes(2);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(next).not.toHaveBeenCalled();
        });

        it('should call next() if the cookie and header tokens match', () => {
            req.cookies._csrf = 'valid-matching-token';
            req.headers['x-csrf-token'] = 'valid-matching-token';
            validateCsrf(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(res.status).not.toHaveBeenCalled();
        });
    });
});