const CircuitBreaker = require('opossum');
const logger = require('./logger');

/**
 * Configuration options for the Mapbox API circuit breaker.
 * These settings mean:
 * - If a request takes longer than 3 seconds, it's considered a failure.
 * - If 50% of requests in the last 10 seconds have failed, the circuit will "open".
 * - When the circuit is open, all calls will fail immediately for 30 seconds.
 * - After 30 seconds, the circuit becomes "half-open" and will let one test request through.
 *   If it succeeds, the circuit closes. If it fails, the 30-second timer resets.
 */
const mapboxOptions = {
  timeout: 3000, // If the function doesn't return in 3 seconds, trigger a failure.
  errorThresholdPercentage: 50, // When 50% of requests fail, open the circuit.
  resetTimeout: 30000 // After 30 seconds in the 'open' state, try again.
};

/**
 * A circuit breaker specifically for Mapbox API calls.
 * It wraps an async function and monitors its success/failure rate.
 */
const mapboxBreaker = new CircuitBreaker(async (fn) => fn(), mapboxOptions);

// --- Event Listeners for Logging & Monitoring ---
// These are invaluable for observing the health of your external services in real-time.

mapboxBreaker.on('open', () => logger.warn('[CircuitBreaker] Mapbox circuit is now OPEN. API calls will be blocked.'));
mapboxBreaker.on('close', () => logger.info('[CircuitBreaker] Mapbox circuit is now CLOSED. API calls are flowing again.'));
mapboxBreaker.on('halfOpen', () => logger.info('[CircuitBreaker] Mapbox circuit is HALF-OPEN. The next call will test the service.'));
mapboxBreaker.on('failure', (error) => logger.error('[CircuitBreaker] Mapbox API call failed.', { error: error.message }));

// You could add more breakers for other external services here.

module.exports = {
  mapboxBreaker
};