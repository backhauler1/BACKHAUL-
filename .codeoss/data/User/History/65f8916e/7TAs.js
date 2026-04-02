/**
 * Express middleware to validate request bodies, queries, and params against Zod schemas.
 * 
 * @param {Object|import('zod').ZodSchema} schemas - Object containing Zod schemas, or a single schema for req.body.
 * @param {import('zod').ZodSchema} [schemas.body] - Schema for req.body
 * @param {import('zod').ZodSchema} [schemas.query] - Schema for req.query
 * @param {import('zod').ZodSchema} [schemas.params] - Schema for req.params
 * @returns {Function} Express middleware function.
 */
const validate = (schemas) => (req, res, next) => {
    // Backwards compatibility: if a direct Zod schema is passed, assume it's for req.body
    const validationSchemas = schemas.safeParse ? { body: schemas } : schemas;

    for (const target of ['body', 'query', 'params']) {
        if (validationSchemas[target]) {
            const validation = validationSchemas[target].safeParse(req[target]);
            
            if (!validation.success) {
                // Return a 400 Bad Request with the first validation error message
                return res.status(400).json({ message: validation.error.errors[0].message });
            }
            
            // Replace the request object with the parsed data to strip unknown fields
            req[target] = validation.data;
        }
    }

    next();
};

module.exports = validate;