/**
 * @jest-environment jsdom
 */

// 1. Mock the Socket.IO client library at the top level.
const mockSocket = {
    on: jest.fn(),
    emit: jest.fn(),
};
const mockIo = jest.fn(() => mockSocket);

// 2. Assign the mock to the global `io` object that the script expects.
global.io = mockIo;

// 3. Import the function we want to test.
import { initializeChatPage } from './chat.js';

describe('chat.js', () => {
    beforeEach(() => {
        // Clear all mocks and reset the DOM before each test to ensure isolation.
        jest.clearAllMocks();
        document.body.innerHTML = '';
    });

    describe('initializeChatPage', () => {
        it('should do nothing if the required chat elements are not found in the DOM', () => {
            // No chat elements are in the DOM for this test.
            initializeChatPage();
            expect(mockIo).not.toHaveBeenCalled();
        });

        it('should log an error and exit if the Socket.IO library is not loaded', () => {
            // Set up the required DOM elements.
            document.body.innerHTML = `
                <div id="chatBox" data-current-user-id="1" data-other-user-id="2"></div>
                <form id="chatForm"><input id="messageInput"></form>
            `;
            // Temporarily undefine the global `io` to simulate it not being loaded.
            const originalIo = global.io;
            global.io = undefined;
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            initializeChatPage();

            expect(consoleErrorSpy).toHaveBeenCalledWith('Socket.IO library not found. Make sure it is loaded before chat.js');
            // Since the function should exit early, no connection should be attempted.
            expect(mockSocket.on).not.toHaveBeenCalled();

            // Restore the mock and the spy for other tests.
            consoleErrorSpy.mockRestore();
            global.io = originalIo;
        });

        it('should log an error if user ID data attributes are missing from the chat container', () => {
            document.body.innerHTML = `
                <div id="chatBox"></div>
                <form id="chatForm"><input id="messageInput"></form>
            `;
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            initializeChatPage();

            expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Missing user ID data attributes on the chat container.');
            expect(mockIo).not.toHaveBeenCalled();

            consoleErrorSpy.mockRestore();
        });

        it('should initialize the chat connection when all elements and data are present', () => {
            document.body.innerHTML = `
                <div id="chatBox" data-current-user-id="1" data-other-user-id="2"></div>
                <form id="chatForm"><input id="messageInput"></form>
            `;

            initializeChatPage();

            expect(mockIo).toHaveBeenCalledTimes(1);
            // Verify that it starts listening for 'connect' and 'message' events.
            expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
            expect(mockSocket.on).toHaveBeenCalledWith('message', expect.any(Function));
        });
    });

    describe('Core Chat Logic', () => {
        let connectCallback;
        let messageCallback;
        const currentUserId = '10';
        const otherUserId = '25';

        beforeEach(() => {
            // Set up the full DOM required for the core logic tests.
            document.body.innerHTML = `
                <div id="chatBox" data-current-user-id="${currentUserId}" data-other-user-id="${otherUserId}" style="height: 100px; overflow-y: scroll;">
                    <p id="noMessages">No messages yet.</p>
                </div>
                <form id="chatForm">
                    <input id="messageInput">
                    <button type="submit">Send</button>
                </form>
            `;

            // Capture the callback functions that `chat.js` passes to `socket.on`.
            mockSocket.on.mockImplementation((event, callback) => {
                if (event === 'connect') connectCallback = callback;
                if (event === 'message') messageCallback = callback;
            });

            initializeChatPage();
        });

        it('should emit a "join" event with the correct room name on connection', () => {
            // Manually trigger the 'connect' event to simulate a server connection.
            connectCallback();

            // The room name should be the two user IDs, sorted and joined by an underscore.
            const expectedRoom = [currentUserId, otherUserId].sort().join('_');
            expect(mockSocket.emit).toHaveBeenCalledWith('join', { room: expectedRoom });
        });

        it('should emit a "send_message" event when the form is submitted with content', () => {
            const chatForm = document.getElementById('chatForm');
            const messageInput = document.getElementById('messageInput');
            messageInput.value = 'Hello there!';

            // Simulate a user submitting the form.
            chatForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

            const expectedRoom = [currentUserId, otherUserId].sort().join('_');
            expect(mockSocket.emit).toHaveBeenCalledWith('send_message', {
                room: expectedRoom,
                content: 'Hello there!',
                sender_id: currentUserId,
                receiver_id: otherUserId
            });
        });

        it('should clear the input and focus it after sending a message', () => {
            const chatForm = document.getElementById('chatForm');
            const messageInput = document.getElementById('messageInput');
            const focusSpy = jest.spyOn(messageInput, 'focus');

            messageInput.value = 'A test message';
            chatForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

            expect(messageInput.value).toBe('');
            expect(focusSpy).toHaveBeenCalled();
        });

        it('should display a received message with the "received" class', () => {
            const chatBox = document.getElementById('chatBox');
            
            // Simulate the server sending a message from the *other* user.
            messageCallback({
                content: 'This is a reply.',
                sender_id: otherUserId,
                timestamp: new Date().toISOString()
            });

            const messageDiv = chatBox.querySelector('.message.received');
            expect(messageDiv).not.toBeNull();
            expect(messageDiv.textContent).toContain('This is a reply.');
            expect(messageDiv.querySelector('.time')).not.toBeNull();
        });

        it('should display a sent message with the "sent" class', () => {
            const chatBox = document.getElementById('chatBox');

            // Simulate the server echoing back a message from the *current* user.
            messageCallback({
                content: 'My own message.',
                sender_id: currentUserId,
                timestamp: new Date().toISOString()
            });

            const messageDiv = chatBox.querySelector('.message.sent');
            expect(messageDiv).not.toBeNull();
            expect(messageDiv.textContent).toContain('My own message.');
        });

        it('should remove the "No messages yet" placeholder when the first message arrives', () => {
            expect(document.getElementById('noMessages')).not.toBeNull();

            messageCallback({ content: 'First!', sender_id: currentUserId, timestamp: new Date().toISOString() });

            expect(document.getElementById('noMessages')).toBeNull();
        });
    });
});