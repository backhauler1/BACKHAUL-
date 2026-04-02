const logger = require('./logger');

/**
 * A utility function to add exponential backoff retry logic to any async function.
 * @param {() => Promise<T>} fn The async function to retry.
 * @param {string} operationName A descriptive name for the operation for logging.
 * @param {number} [maxRetries=3] Maximum number of retries.
 * @param {number} [initialDelay=100] Delay for the first retry in ms.
 * @returns {Promise<T>}
 * @template T
 */
async function withRetry(fn, operationName, maxRetries = 3, initialDelay = 100) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (error) {
            attempt++;
            // Only retry on specific, transient error codes like connection resets or timeouts.
            const isRetryable = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === '53300'; // PG's "too many connections"

            if (isRetryable && attempt < maxRetries) {
                const delay = initialDelay * Math.pow(2, attempt - 1);
                logger.warn(`[Retry] Operation '${operationName}' failed. Retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries})`, { error: error.message });
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error; // Re-throw the error if it's not retryable or retries are exhausted.
            }
        }
    }
}

module.exports = { withRetry };