const { numericParamSchema } = require('./commonSchemas');

describe('Common Schemas (commonSchemas.js)', () => {
    describe('numericParamSchema', () => {
        it('should validate and coerce valid string integers to numbers', () => {
            const schema = numericParamSchema('orderId');
            
            const result = schema.parse({ orderId: '123' });
            expect(result).toEqual({ orderId: 123 }); // Strict number equality
        });

        it('should reject non-numeric strings', () => {
            const schema = numericParamSchema('userId');
            expect(() => schema.parse({ userId: 'abc' })).toThrow();
        });

        it('should reject negative numbers or zero', () => {
            const schema = numericParamSchema('loadId');
            expect(() => schema.parse({ loadId: '-5' })).toThrow();
            expect(() => schema.parse({ loadId: '0' })).toThrow();
        });

        it('should reject decimal/float numbers', () => {
            const schema = numericParamSchema('companyId');
            // The z.int() modifier should cause this to throw
            expect(() => schema.parse({ companyId: '10.5' })).toThrow();
        });
    });
});
