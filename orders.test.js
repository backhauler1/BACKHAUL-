const pool = require('./db');
const { createPendingOrder, fulfillOrder } = require('./orders');

// 1. Mock the Database Pool
jest.mock('./db', () => ({
    query: jest.fn(),
    connect: jest.fn(),
}));

describe('Orders Database Logic', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();

        // 2. Setup the mock client returned by pool.connect()
        mockClient = {
            query: jest.fn(),
            release: jest.fn(),
        };
        pool.connect.mockResolvedValue(mockClient);
    });

    describe('createPendingOrder', () => {
        it('should execute a successful transaction and insert the order with its items', async () => {
            // Mock the response for the main order INSERT query
            const mockOrder = { id: 101, user_id: 1, stripe_payment_intent_id: 'pi_123', amount: 5000, status: 'pending' };
            
            // We need to carefully mock the sequence of queries passing through mockClient
            mockClient.query.mockImplementation((queryText) => {
                if (queryText.includes('INSERT INTO orders')) {
                    return Promise.resolve({ rows: [mockOrder] });
                }
                // Default response for BEGIN, COMMIT, and order_items INSERT
                return Promise.resolve({ rows: [] }); 
            });

            const items = [{ description: 'Premium Listing', quantity: 1, unit_price: 5000, total_price: 5000 }];
            
            const result = await createPendingOrder(1, 'pi_123', 5000, 'usd', items);

            // Assertions
            expect(result).toEqual(mockOrder);
            
            // Verify the transaction lifecycle
            expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
            
            // Verify order insertion (2nd query)
            const orderInsertCall = mockClient.query.mock.calls[1];
            expect(orderInsertCall[0]).toContain('INSERT INTO orders');
            expect(orderInsertCall[1]).toEqual([1, 'pi_123', 5000, 'usd', 'pending']);
            
            // Verify order_items insertion (3rd query)
            const itemInsertCall = mockClient.query.mock.calls[2];
            expect(itemInsertCall[0]).toContain('INSERT INTO order_items');
            expect(itemInsertCall[1]).toEqual([101, 'Premium Listing', 1, 5000, 5000]);
            
            // Verify commit and release
            expect(mockClient.query).toHaveBeenLastCalledWith('COMMIT');
            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });

        it('should execute ROLLBACK and release the client if an error occurs', async () => {
            const dbError = new Error('Database insertion failed');
            
            // Simulate an error during the order insertion
            mockClient.query.mockImplementation((queryText) => {
                if (queryText.includes('INSERT INTO orders')) {
                    return Promise.reject(dbError);
                }
                return Promise.resolve();
            });

            await expect(
                createPendingOrder(1, 'pi_fail', 5000, 'usd', [])
            ).rejects.toThrow('Database insertion failed');

            // Verify the transaction lifecycle
            expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
            expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
            
            // Ensure the client is still released back to the pool even after an error
            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });
    });

    describe('fulfillOrder', () => {
        it('should update the order status via pool.query', async () => {
            const mockUpdatedOrder = { id: 101, status: 'succeeded' };
            pool.query.mockResolvedValueOnce({ rows: [mockUpdatedOrder] });

            const result = await fulfillOrder('pi_123', 'succeeded');

            expect(result).toEqual(mockUpdatedOrder);
            
            // Verify the standalone query used pool.query directly
            const updateCall = pool.query.mock.calls[0];
            expect(updateCall[0]).toContain('UPDATE orders');
            expect(updateCall[1]).toEqual(['succeeded', 'pi_123']);
        });
    });
});