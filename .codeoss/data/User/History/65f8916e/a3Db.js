/**
 * Express middleware to validate request bodies against a Zod schema.
 * 
 * @param {import('zod').ZodSchema} schema - The Zod schema to validate against.
 * @returns {Function} Express middleware function.
 */
const validate = (schema) => (req, res, next) => {
    const validation = schema.safeParse(req.body);
    
    if (!validation.success) {
        // Return a 400 Bad Request with the first validation error message
        return res.status(400).json({ message: validation.error.errors[0].message });
    }
    
    // Replace req.body with the parsed data to strip unknown fields
    req.body = validation.data;
    next();
};

module.exports = validate;