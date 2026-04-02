const { Client } = require('pg');
const logger = require('./logger');

jest.mock('node-pg-migrate', () => ({
    __esModule: true,
    default: jest.fn(),
}));

// Hoist mock functions so they are accessible throughout the test file.
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockEnd = jest.fn();
jest.mock('pg', () => {
    return {
        Client: jest.fn(() => ({
            connect: mockConnect,
            query: mockQuery,
            end: mockEnd,
        })),
    };
});

// 3. Mock the logger
jest.mock('./logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
}));

describe('Migration Script (migrate.js)', () => {
    let migrate;

    beforeEach(() => {
        jest.resetModules(); // This is the key change!
        jest.clearAllMocks();
        // Re-require the mocked module after resetting so it's available in tests
        migrate = require('node-pg-migrate').default;
        
        // Set up test environment variables matching the script's expectations
        process.env.DB_USER = 'testuser';
        process.env.DB_PASSWORD = 'testpassword';
        process.env.DB_HOST = 'localhost';
        process.env.DB_PORT = '5432';
        process.env.DB_NAME = 'testdb';

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
        mockQuery.mockResolvedValueOnce({ rowCount: 0 }); 
        // Second query creates the database
        mockQuery.mockResolvedValueOnce({}); 

        // Mock the `migrate` function
        migrate.mockResolvedValueOnce();

        // Now require the module *after* env vars are set
        const { runMigrations } = require('./migrate');

        await runMigrations();

        // Assert the Client was instantiated twice (once for root check, once for actual DB)
        expect(Client).toHaveBeenCalledTimes(2);
        
        // The first client should connect without a specific database to check existence globally
        expect(Client.mock.calls[0][0]).not.toHaveProperty('database');
        
        // The second client should connect to the target database
        expect(Client.mock.calls[1][0]).toHaveProperty('database', 'testdb');

        // Verify the database existence check and creation were executed
        expect(mockQuery).toHaveBeenCalledWith('SELECT 1 FROM pg_database WHERE datname = $1', ['testdb']);
        expect(mockQuery).toHaveBeenCalledWith('CREATE DATABASE "testdb"');
        
        // Verify logs
        expect(logger.info).toHaveBeenCalledWith('Database "testdb" does not exist. Creating...');
        expect(logger.info).toHaveBeenCalledWith('Database "testdb" created.');

        // Verify the migration execution
        expect(migrate).toHaveBeenCalledWith(expect.objectContaining({
            dbClient: expect.any(Object),
            direction: 'up',
            dir: expect.stringContaining('migrations')
        }));

        // Verify both clients were gracefully closed
        expect(mockEnd).toHaveBeenCalledTimes(2);
    });

    it('should NOT attempt to create the database if it already exists', async () => {
        // Mock query returning 1 row, meaning the DB already exists
        mockQuery.mockResolvedValueOnce({ rowCount: 1 });
        migrate.mockResolvedValueOnce();

        const { runMigrations } = require('./migrate');
        await runMigrations();

        expect(mockQuery).toHaveBeenCalledTimes(1); // Only the SELECT query
        expect(mockQuery).not.toHaveBeenCalledWith('CREATE DATABASE "testdb"');
        expect(logger.info).not.toHaveBeenCalledWith('Database "testdb" does not exist. Creating...');
    });

    it('should log an error and throw if database creation/connection fails', async () => {
        const dbError = new Error('Connection failed');
        mockConnect.mockRejectedValueOnce(dbError); // Force a failure on connect

        const { runMigrations } = require('./migrate');
        await expect(runMigrations()).rejects.toThrow('Connection failed');

        expect(logger.error).toHaveBeenCalledWith('Error checking/creating database:', dbError);
        expect(migrate).not.toHaveBeenCalled(); // Migration should not execute
        expect(mockEnd).toHaveBeenCalledTimes(1); // The client from the finally block should still close
    });
});