const request = require('supertest');
const bcrypt = require('bcrypt');
const pool = require('./db'); // Uses the test DB via .env.test
const app = require('./server'); // Import the configured Express app

describe('Authentication Flow', () => {
    // Use a supertest agent to automatically handle and send cookies
    const agent = request.agent(app);
    let testUser, adminUser;

    // 1. SETUP: Before any tests run, clear the users table and create test users.
    beforeAll(async () => {
        await pool.query('DELETE FROM users');

        const hashedPassword = await bcrypt.hash('password123', 10);

        // Create a regular user
        const userRes = await pool.query(
            `INSERT INTO users (name, email, password, roles) VALUES ($1, $2, $3, $4) RETURNING *`,
            ['Test User', 'test@example.com', hashedPassword, ['user']]
        );
        testUser = userRes.rows[0];

        // Create an admin user
        const adminRes = await pool.query(
            `INSERT INTO users (name, email, password, roles) VALUES ($1, $2, $3, $4) RETURNING *`,
            ['Admin User', 'admin@example.com', hashedPassword, ['user', 'admin']]
        );
        adminUser = adminRes.rows[0];
    });

    // 2. TEARDOWN: After all tests, close the database connection pool.
    afterAll(async () => {
        await pool.end();
    });

    describe('POST /api/auth/login', () => {
        it('should reject login with incorrect password', async () => {
            const res = await agent
                .post('/api/auth/login')
                .send({ email: 'test@example.com', password: 'wrongpassword' });

            expect(res.statusCode).toEqual(401);
            expect(res.body.message).toBe('Invalid credentials.');
        });

        it('should successfully log in a user and set httpOnly cookies', async () => {
            const res = await agent
                .post('/api/auth/login')
                .send({ email: 'test@example.com', password: 'password123' });

            expect(res.statusCode).toEqual(200);
            expect(res.body.user.email).toBe('test@example.com');

            // Check that the cookies were set correctly
            const cookies = res.headers['set-cookie'];
            expect(cookies.some(cookie => cookie.startsWith('token='))).toBe(true);
            expect(cookies.some(cookie => cookie.startsWith('refreshToken='))).toBe(true);
            expect(cookies.every(cookie => cookie.includes('HttpOnly'))).toBe(true);

            // Verify the refresh token was saved in the DB
            const dbUser = await pool.query('SELECT refresh_token FROM users WHERE id = $1', [testUser.id]);
            expect(dbUser.rows[0].refresh_token).not.toBeNull();
        });
    });

    describe('Protected and Authorized Routes', () => {
        // This test runs after the successful login above, so the agent has cookies.
        it('should allow an admin to access an admin-only route', async () => {
            // First, log in as the admin user
            await agent
                .post('/api/auth/login')
                .send({ email: 'admin@example.com', password: 'password123' });

            // Then, attempt to access the protected route
            const res = await agent
                .post('/api/companies/register')
                .field('companyName', 'Admin Corp') // .field for multipart/form-data
                .field('description', 'A test company');

            // We expect 201 Created because the user is an admin
            expect(res.statusCode).toEqual(201);
            expect(res.body.message).toBe('Company registered successfully!');
        });

        it('should forbid a non-admin user from accessing an admin-only route', async () => {
            // First, log in as the regular user
            await agent
                .post('/api/auth/login')
                .send({ email: 'test@example.com', password: 'password123' });

            // Then, attempt to access the protected route
            const res = await agent
                .post('/api/companies/register')
                .field('companyName', 'Test Corp');

            // We expect 403 Forbidden because the user does not have the 'admin' role
            expect(res.statusCode).toEqual(403);
            expect(res.body.message).toContain('You do not have permission');
        });
    });

    describe('POST /api/auth/refresh', () => {
        it('should successfully refresh an access token', async () => {
            // The agent already has a valid refreshToken from a previous login
            const res = await agent.post('/api/auth/refresh');

            expect(res.statusCode).toEqual(200);
            expect(res.body.message).toBe('Access token refreshed successfully.');

            // Check that a *new* access token was set
            const cookies = res.headers['set-cookie'];
            expect(cookies.some(cookie => cookie.startsWith('token='))).toBe(true);
        });
    });

    describe('POST /api/auth/logout', () => {
        it('should successfully log out a user and clear cookies', async () => {
            // Ensure user is logged in first
            await agent
                .post('/api/auth/login')
                .send({ email: 'test@example.com', password: 'password123' });

            // Check that the refresh token exists in the DB before logout
            let dbUser = await pool.query('SELECT refresh_token FROM users WHERE id = $1', [testUser.id]);
            expect(dbUser.rows[0].refresh_token).not.toBeNull();

            // Perform the logout
            const res = await agent.post('/api/auth/logout');

            expect(res.statusCode).toEqual(200);
            expect(res.body.message).toBe('Logged out successfully.');

            // Check that cookies are cleared (max-age=0)
            const cookies = res.headers['set-cookie'];
            expect(cookies.some(cookie => cookie.includes('token=;'))).toBe(true);
            expect(cookies.some(cookie => cookie.includes('refreshToken=;'))).toBe(true);

            // Verify the refresh token was cleared from the DB
            dbUser = await pool.query('SELECT refresh_token FROM users WHERE id = $1', [testUser.id]);
            expect(dbUser.rows[0].refresh_token).toBeNull();
        });

        it('should fail to access a protected route after logout', async () => {
            // The agent's cookies were cleared by the previous test.
            const res = await agent
                .post('/api/companies/register')
                .field('companyName', 'Ghost Corp');

            expect(res.statusCode).toEqual(401);
            expect(res.body.message).toContain('Not authorized');
        });
    });
});