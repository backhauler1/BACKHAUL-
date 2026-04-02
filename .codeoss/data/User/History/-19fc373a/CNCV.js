const { initializeSocketHandlers } = require('./socketHandlers');
const pool = require('./db');
const logger = require('./logger');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// 1. Mock all external dependencies
jest.mock('./db');
jest.mock('./logger');

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(() => ({
        send: mockS3Send,
    })),
    PutObjectCommand: jest.fn((args) => ({ type: 'PutObject', args })),
    GetObjectCommand: jest.fn((args) => ({ type: 'GetObject', args })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: jest.fn(),
}));

// 2. Create mock Socket.IO server and client objects
const mockIo = {
    on: jest.fn(),
    to: jest.fn(() => mockIo), // Return self for chaining: io.to(room).emit()
    emit: jest.fn(),
};

const mockSocket = {
    on: jest.fn(),
    emit: jest.fn(),
    join: jest.fn(),
    to: jest.fn(() => mockSocket), // Return self for chaining: socket.to(room).emit()
};

describe('Socket.IO Handlers (socketHandlers.js)', () => {
    let connectionCallback;
    const eventHandlers = {};

    // 3. Before each test, re-initialize the handlers and capture the callbacks
    beforeEach(() => {
        jest.clearAllMocks();

        // Capture the main 'connection' callback from io.on('connection', ...)
        mockIo.on.mockImplementation((event, callback) => {
            if (event === 'connection') {
                connectionCallback = callback;
            }
        });

        // Capture all the individual event handlers like 'send_message', 'join', etc.
        mockSocket.on.mockImplementation((event, handler) => {
            eventHandlers[event] = handler;
        });

        // Initialize our socket handlers with the mock server
        initializeSocketHandlers(mockIo);
        // Simulate a client connecting, which triggers the setup of all event listeners
        connectionCallback(mockSocket);
    });

    describe('send_message handler', () => {
        it('should save a text-only message and broadcast it to the room', async () => {
            const messageData = {
                room: 'user1_user2',
                content: 'Hello, world!',
                sender_id: 'user1',
                receiver_id: 'user2',
            };
            const mockDbResponse = { id: 1, ...messageData, image_url: null, timestamp: new Date().toISOString() };
            pool.query.mockResolvedValue({ rows: [mockDbResponse] });

            // Simulate the client emitting the 'send_message' event
            await eventHandlers.send_message(messageData);

            // Verify database insertion with no image key
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO messages'), ['user1', 'user2', 'Hello, world!', null]);

            // Verify the message was broadcast to the correct room
            expect(mockIo.to).toHaveBeenCalledWith('user1_user2');
            const emittedMessage = mockIo.emit.mock.calls[0][1];
            expect(emittedMessage.content).toBe('Hello, world!');
            expect(emittedMessage.image).toBe(null); // No signed URL
        });

        it('should upload an image, save key to DB, and broadcast with a signed URL', async () => {
            const messageData = {
                room: 'user1_user2',
                content: 'Check this out',
                sender_id: 'user1',
                receiver_id: 'user2',
                image: 'data:image/png;base64,FAKEDATA'
            };
            const mockDbResponse = { id: 2, ...messageData, image_url: 'chat-images/mock-key.png', timestamp: new Date().toISOString() };
            delete mockDbResponse.image; // The raw base64 is not in the DB response

            pool.query.mockResolvedValue({ rows: [mockDbResponse] });
            getSignedUrl.mockResolvedValue('https://s3.mock/signed-url-for/mock-key.png');

            await eventHandlers.send_message(messageData);

            // Verify S3 upload was attempted
            expect(mockS3Send).toHaveBeenCalledWith(expect.objectContaining({ type: 'PutObject' }));

            // Verify signed URL generation was called
            expect(getSignedUrl).toHaveBeenCalledWith(expect.any(S3Client), expect.any(GetObjectCommand), { expiresIn: 3600 });

            // Verify DB was called with an image key
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO messages'), ['user1', 'user2', 'Check this out', expect.stringContaining('chat-images/')]);

            // Verify broadcast included the signed URL
            expect(mockIo.to).toHaveBeenCalledWith('user1_user2');
            const emittedMessage = mockIo.emit.mock.calls[0][1];
            expect(emittedMessage.image).toBe('https://s3.mock/signed-url-for/mock-key.png');
        });

        it('should emit a send_message_error if the database query fails', async () => {
            const messageData = { room: 'user1_user2', content: 'This will fail' };
            const dbError = new Error('DB connection lost');
            pool.query.mockRejectedValue(dbError);

            await eventHandlers.send_message(messageData);

            expect(logger.error).toHaveBeenCalledWith('Error handling send_message:', expect.any(Object));
            expect(mockSocket.emit).toHaveBeenCalledWith('send_message_error', { message: 'Could not send your message.' });
            expect(mockIo.emit).not.toHaveBeenCalled(); // Should not broadcast on error
        });
    });

    describe('join handler', () => {
        it('should join the room and emit historical messages with signed URLs', async () => {
            const joinData = { room: 'user1_user2' };
            const mockHistory = [
                { id: 1, content: 'Old message', image_url: null, sender_id: 'user1' },
                { id: 2, content: 'Message with image', image_url: 'chat-images/old-image.png', sender_id: 'user2' }
            ];
            pool.query.mockResolvedValue({ rows: mockHistory });
            getSignedUrl.mockResolvedValue('https://s3.mock/signed-url-for/old-image.png');

            await eventHandlers.join(joinData);

            expect(mockSocket.join).toHaveBeenCalledWith('user1_user2');
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM ('), ['user1', 'user2']);
            expect(getSignedUrl).toHaveBeenCalledTimes(1);

            // Verify historical messages were emitted back to the joining client
            expect(mockSocket.emit).toHaveBeenCalledTimes(2);
            expect(mockSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({ content: 'Old message', image: null }));
            expect(mockSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({ content: 'Message with image', image: 'https://s3.mock/signed-url-for/old-image.png' }));
        });
    });

    describe('load_older_messages handler', () => {
        it('should fetch and emit older messages based on a timestamp', async () => {
            const loadData = { room: 'user1_user2', beforeTimestamp: '2023-01-01T12:00:00.000Z' };
            const mockOlderHistory = [{ id: 1, content: 'Very old message', image_url: null }];
            pool.query.mockResolvedValue({ rows: mockOlderHistory });

            await eventHandlers.load_older_messages(loadData);

            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('created_at < $3'), ['user1', 'user2', '2023-01-01T12:00:00.000Z']);
            expect(mockSocket.emit).toHaveBeenCalledWith('older_messages', expect.any(Array));
            const emittedPayload = mockSocket.emit.mock.calls[0][1];
            expect(emittedPayload[0].content).toBe('Very old message');
        });
    });

    describe('mark_as_read handler', () => {
        it('should update message statuses and broadcast the change', async () => {
            const readData = { messageIds: [10, 11], room: 'user1_user2', readerId: 'user2' };
            pool.query.mockResolvedValue({ rowCount: 2 });

            await eventHandlers.mark_as_read(readData);

            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE messages SET read_at'), [[10, 11], 'user2']);
            expect(mockIo.to).toHaveBeenCalledWith('user1_user2');
            expect(mockIo.emit).toHaveBeenCalledWith('messages_read', { messageIds: [10, 11] });
        });
    });

    describe('typing_status handler', () => {
        it('should broadcast the typing status to other users in the room', () => {
            const typingData = { room: 'user1_user2', userId: 'user1', isTyping: true };

            eventHandlers.typing_status(typingData);

            // Verify broadcast to the room (excluding the sender)
            expect(mockSocket.to).toHaveBeenCalledWith('user1_user2');
            expect(mockSocket.emit).toHaveBeenCalledWith('typing_status', typingData);
        });
    });

    describe('message_delivered handler', () => {
        it('should broadcast a message_was_delivered event to the room', () => {
            const deliveryData = { messageId: 123, room: 'user1_user2' };

            // Simulate the client emitting the event
            eventHandlers.message_delivered(deliveryData);

            // Verify the server broadcasts the confirmation back to the room
            expect(mockIo.to).toHaveBeenCalledWith('user1_user2');
            expect(mockIo.emit).toHaveBeenCalledWith('message_was_delivered', { messageId: 123 });
        });
    });
});