const { geocodeAddress } = require('./geocodingService');

// 1. Mock the dependencies at the top level
const mockFire = jest.fn();
const mockFire = jest.fn();
jest.mock('@mapbox/mapbox-sdk/services/geocoding', () => {
    return jest.fn(() => ({
        forwardGeocode: jest.fn(() => ({
            send: mockSend,
        })),
    }));
});

jest.mock('./circuitBreaker', () => ({
    mapboxBreaker: {
        fire: mockFire,
    },
}));

const logger = require('./logger');
jest.mock('./logger', () => ({
    warn: jest.fn(),
    error: jest.fn(),
}));

describe('Geocoding Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // By default, mock the circuit breaker's `fire` method to just execute the function passed to it.
        mockFire.mockImplementation(async (fn) => fn());
    });

    it('should return coordinates for a valid address', async () => {
        mockSend.mockResolvedValue({
            body: { features: [{ center: [-74.006, 40.7128] }] }
        });

        const result = await geocodeAddress('New York, NY');

        expect(result).toEqual([-74.006, 40.7128]);
        expect(mockFire).toHaveBeenCalledTimes(1);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should return null when Mapbox finds no features for an address', async () => {
        mockSend.mockResolvedValue({ body: { features: [] } });

        const result = await geocodeAddress('NonExistentPlace 123');

        expect(result).toBeNull();
        expect(mockFire).toHaveBeenCalledTimes(1);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should return null for invalid or empty input without calling the API', async () => {
        expect(await geocodeAddress(null)).toBeNull();
        expect(await geocodeAddress(undefined)).toBeNull();
        expect(await geocodeAddress('   ')).toBeNull();

        expect(mockFire).not.toHaveBeenCalled();
    });

    it('should return null and log a warning when the circuit breaker is open', async () => {
        const breakerOpenError = new Error('Circuit breaker is open');
        breakerOpenError.code = 'EOPENBREAKER';
        mockFire.mockRejectedValue(breakerOpenError);

        const result = await geocodeAddress('Some Address');

        expect(result).toBeNull();
        expect(mockFire).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Geocoding for "Some Address" blocked because the Mapbox circuit is open.'));
    });

    it('should return null and log an error for other Mapbox API failures', async () => {
        const apiError = new Error('Mapbox API is down');
        mockFire.mockRejectedValue(apiError);

        const result = await geocodeAddress('Some Address');

        expect(result).toBeNull();
        expect(mockFire).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith('Geocoding failed for address "Some Address":', { error: 'Mapbox API is down' });
    });
});