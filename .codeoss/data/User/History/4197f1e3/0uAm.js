const { z } = require('zod');

/**
 * Generates a Zod schema to validate generic numeric URL parameters.
 * @param {string} paramName - The name of the parameter (e.g., 'orderId', 'id')
 * @returns {import('zod').ZodObject}
 */
const numericParamSchema = (paramName) => z.object({
    [paramName]: z.coerce.number().int().positive(`Invalid ${paramName}.`)
});

module.exports = { numericParamSchema };