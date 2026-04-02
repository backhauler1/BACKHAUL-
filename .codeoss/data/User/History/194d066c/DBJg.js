/*
    Handles real-time chat functionality using WebSockets (Socket.IO).
*/
document.addEventListener('DOMContentLoaded', () => {
    // The main chat container should have data attributes for user IDs.
    // e.g., <div id="chatBox" data-current-user-id="123" data-other-user-id="456">...</div>
    const chatContainer = document.getElementById('chatBox');
    const chatForm = document.getElementById('chatForm');
    const messageInput = document.getElementById('messageInput');

    // Ensure elements exist and the Socket.IO library is loaded
    if (chatContainer && chatForm && messageInput && typeof io !== 'undefined') {
        const currentUserId = chatContainer.dataset.currentUserId;
        const otherUserId = chatContainer.dataset.otherUserId;

        if (currentUserId && otherUserId) {
            initializeChat(currentUserId, otherUserId, chatContainer, chatForm, messageInput);
        } else {
            console.error('Error: Missing user ID data attributes on the chat container.');
        }
    } else if (typeof io === 'undefined') {
        console.error('Socket.IO library not found. Make sure it is loaded before chat.js');
    }
});

function initializeChat(currentUserId, otherUserId, chatBox, chatForm, messageInput) {
    // Auto-scroll to the bottom of the chat box
    chatBox.scrollTop = chatBox.scrollHeight;

    // Connect to the Socket.IO server
    const socket = io();

    // Create a unique room name for this pair of users
    const room = [currentUserId, otherUserId].sort().join('_');

    // Join the room when the page loads
    socket.on('connect', () => {
        console.log('Connected to WebSocket server.');
        socket.emit('join', { room: room });
    });

    // Listen for new messages from the server
    socket.on('message', (data) => {
        // Remove the "No messages yet" placeholder if it exists
        const noMessagesEl = document.getElementById('noMessages');
        if (noMessagesEl) {
            noMessagesEl.remove();
        }

        // Create the new message element
        const messageDiv = document.createElement('div');
        const messageClass = data.sender_id == currentUserId ? 'sent' : 'received';
        messageDiv.className = `message ${messageClass}`;

        // Format timestamp
        const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // Use textContent to prevent XSS vulnerabilities
        const contentNode = document.createTextNode(data.content + ' ');
        const timeSpan = document.createElement('span');
        timeSpan.className = 'time';
        timeSpan.textContent = time;

        messageDiv.appendChild(contentNode);
        messageDiv.appendChild(timeSpan);

        // Append the message to the chat box and scroll down
        chatBox.appendChild(messageDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
    });

    // Handle form submission
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const messageContent = messageInput.value.trim();

        if (messageContent) {
            socket.emit('send_message', {
                room: room,
                content: messageContent,
                sender_id: currentUserId,
                receiver_id: otherUserId
            });
            messageInput.value = '';
            messageInput.focus();
        }
    });
}