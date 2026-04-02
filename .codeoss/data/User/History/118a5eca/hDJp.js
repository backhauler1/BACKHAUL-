const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const { mapboxBreaker } = require('./circuitBreaker');
const logger = require('./logger');

// Ensure you have MAPBOX_TOKEN in your .env file
const geocodingService = mbxGeocoding({ accessToken: process.env.MAPBOX_TOKEN });

/**
 * Geocodes an address string to [longitude, latitude] coordinates using Mapbox,
 * wrapped in a circuit breaker for resilience.
 *
 * @param {string} address The address to geocode.
 * @returns {Promise<[number, number]|null>} A promise that resolves to [lng, lat] or null if geocoding fails or the circuit is open.
 */
async function geocodeAddress(address) {
  if (!address || typeof address !== 'string' || address.trim() === '') {
    return null;
  }

  try {
    // This is the core async function the circuit breaker will execute.
    const geocodeFn = async () => {
      const response = await geocodingService
        .forwardGeocode({
          query: address,
          limit: 1,
          // Optional: Bias results to a region if applicable (e.g., US and Canada)
          // countries: ['US', 'CA'],
        })
        .send();

      if (response && response.body && response.body.features && response.body.features.length > 0) {
        return response.body.features[0].center; // Returns [lng, lat]
      }
      // If Mapbox returns a valid response but no features, it's not a "failure" for the breaker,
      // but we should return null to the caller.
      return null;
    };

    // Fire the function through the circuit breaker.
    return await mapboxBreaker.fire(geocodeFn);

  } catch (error) {
    // This block catches errors from the circuit breaker itself (e.g., EOPENBREAKER when the circuit is open)
    // or if the geocodeFn throws an unhandled exception.
    if (error.code === 'EOPENBREAKER') {
      logger.warn(`[CircuitBreaker] Geocoding for "${address}" blocked because the Mapbox circuit is open.`);
    } else {
      logger.error(`Geocoding failed for address "${address}":`, { error: error.message });
    }
    // Return null to allow the parent operation (like registering a truck) to proceed
    // without coordinates, rather than failing the whole request.
    return null;
  }
}

module.exports = { geocodeAddress };