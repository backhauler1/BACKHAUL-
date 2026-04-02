// 1. Mock the 'pg' module. We are interested in the Pool constructor.
const mockPool = jest.fn();
jest.mock('pg', () => ({
    Pool: mockPool,
}));

describe('Database Pool Module (db.js)', () => {
    // 2. Store the original environment variables
    const OLD_ENV = process.env;

    beforeEach(() => {
        // Reset modules before each test to ensure a clean state.
        // This is crucial because db.js likely creates the pool on first require.
        jest.resetModules();
        // Restore environment variables to a clean state
        process.env = { ...OLD_ENV };
        // Clear any previous calls to the mock
        mockPool.mockClear();
    });

    afterAll(() => {
        // Restore the original environment after all tests have run
        process.env = OLD_ENV;
    });

    it('should create a Pool instance with configuration from environment variables', () => {
        // Arrange: Set up environment variables for this specific test
        process.env.DB_USER = 'test_user';
        process.env.DB_PASSWORD = 'test_password';
        process.env.DB_HOST = 'test_host';
        process.env.DB_PORT = '1234';
        process.env.DB_NAME = 'test_db';

        // Act: Require the db module, which should instantiate the Pool
        require('./db');

        // Assert
        expect(mockPool).toHaveBeenCalledTimes(1);
        expect(mockPool).toHaveBeenCalledWith({
            user: 'test_user',
            password: 'test_password',
            host: 'test_host',
            port: 1234, // Should be parsed as a number
            database: 'test_db',
        });
    });

    it('should export the created pool instance directly', () => {
        // Arrange: Configure the mock constructor to return a specific object
        const mockPoolInstance = { id: 'mock-pool-instance' };
        mockPool.mockReturnValue(mockPoolInstance);

        // Act: Require the db module
        const pool = require('./db');

        // Assert: The exported module should be the exact instance we created
        expect(pool).toBe(mockPoolInstance);
    });

    it('should handle an undefined DB_PORT gracefully', () => {
        // Arrange
        process.env.DB_USER = 'test_user';
        process.env.DB_HOST = 'test_host';
        process.env.DB_NAME = 'test_db';
        delete process.env.DB_PORT; // Ensure port is not set

        // Act
        require('./db');

        // Assert: The config passed to the Pool should not have a port property,
        // allowing the `pg` library to use its own default.
        const config = mockPool.mock.calls[0][0];
        expect(config).not.toHaveProperty('port');
    });
});