const { runMigrations } = require('./migrate');
const migrate = require('node-pg-migrate').default;
const { Client } = require('pg');
const logger = require('./logger');

// 1. Mock the node-pg-migrate module
jest.mock('node-pg-migrate', () => ({
    __esModule: true,
    default: jest.fn(),
}));

// 2. Mock the pg module and its Client instance
jest.mock('pg', () => {
    const mockClient = {
        connect: jest.fn(),
        query: jest.fn(),
        end: jest.fn(),
    };
    return {
        Client: jest.fn(() => mockClient),
    };
});

// 3. Mock the logger
jest.mock('./logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
}));

describe('Migration Script (migrate.js)', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Set up test environment variables matching the script's expectations
        process.env.DB_USER = 'testuser';
        process.env.DB_PASSWORD = 'testpassword';
        process.env.DB_HOST = 'localhost';
        process.env.DB_PORT = '5432';
        process.env.DB_NAME = 'testdb';

        // Get a reference to the mocked methods to easily configure responses
        mockClient = new Client();
    });

    afterEach(() => {
        // Clean up environment variables
        delete process.env.DB_USER;
        delete process.env.DB_PASSWORD;
        delete process.env.DB_HOST;
        delete process.env.DB_PORT;
        delete process.env.DB_NAME;
    });

    it('should create the database if it does not exist and then run migrations', async () => {
        // Mock `ensureDatabaseExists` queries
        // First query checks existence (returns 0 rows meaning it doesn't exist)
        mockClient.query.mockResolvedValueOnce({ rowCount: 0 }); 
        // Second query creates the database
        mockClient.query.mockResolvedValueOnce({}); 

        // Mock the `migrate` function
        migrate.mockResolvedValueOnce();

        await runMigrations();

        // Assert the Client was instantiated twice (once for root check, once for actual DB)
        expect(Client).toHaveBeenCalledTimes(2);
        
        // The first client should connect without a specific database to check existence globally
        expect(Client.mock.calls[0][0]).not.toHaveProperty('database');
        
        // The second client should connect to the target database
        expect(Client.mock.calls[1][0]).toHaveProperty('database', 'testdb');

        // Verify the database existence check and creation were executed
        expect(mockClient.query).toHaveBeenCalledWith('SELECT 1 FROM pg_database WHERE datname = $1', ['testdb']);
        expect(mockClient.query).toHaveBeenCalledWith('CREATE DATABASE "testdb"');
        
        // Verify logs
        expect(logger.info).toHaveBeenCalledWith('Database "testdb" does not exist. Creating...');
        expect(logger.info).toHaveBeenCalledWith('Database "testdb" created.');

        // Verify the migration execution
        expect(migrate).toHaveBeenCalledWith(expect.objectContaining({
            dbClient: mockClient,
            direction: 'up',
            dir: expect.stringContaining('migrations')
        }));

        // Verify both clients were gracefully closed
        expect(mockClient.end).toHaveBeenCalledTimes(2);
    });

    it('should NOT attempt to create the database if it already exists', async () => {
        // Mock query returning 1 row, meaning the DB already exists
        mockClient.query.mockResolvedValueOnce({ rowCount: 1 });
        migrate.mockResolvedValueOnce();

        await runMigrations();

        expect(mockClient.query).toHaveBeenCalledTimes(1); // Only the SELECT query
        expect(mockClient.query).not.toHaveBeenCalledWith('CREATE DATABASE "testdb"');
        expect(logger.info).not.toHaveBeenCalledWith('Database "testdb" does not exist. Creating...');
    });

    it('should log an error and throw if database creation/connection fails', async () => {
        const dbError = new Error('Connection failed');
        mockClient.connect.mockRejectedValueOnce(dbError); // Force a failure on connect

        await expect(runMigrations()).rejects.toThrow('Connection failed');

        expect(logger.error).toHaveBeenCalledWith('Error checking/creating database:', dbError);
        expect(migrate).not.toHaveBeenCalled(); // Migration should not execute
        expect(mockClient.end).toHaveBeenCalledTimes(1); // The client from the finally block should still close
    });
});