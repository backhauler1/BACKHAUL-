/*
    Handles real-time chat functionality using WebSockets (Socket.IO).
*/

/**
 * Initializes the chat page functionality.
 * This function should be called when the DOM is ready on a page with the chat interface.
 */
export function initializeChatPage() {
    const chatContainer = document.getElementById('chatBox');
    const chatForm = document.getElementById('chatForm');
    const messageInput = document.getElementById('messageInput');

    // Ensure elements exist and the Socket.IO library is loaded
    if (!chatContainer || !chatForm || !messageInput) {
        return; // Not a chat page, or elements are missing.
    }
    if (typeof io === 'undefined') {
        console.error('Socket.IO library not found. Make sure it is loaded before chat.js');
        return;
    }

    const currentUserId = chatContainer.dataset.currentUserId;
    const otherUserId = chatContainer.dataset.otherUserId;

    if (currentUserId && otherUserId) {
        _initializeChat(currentUserId, otherUserId, chatContainer, chatForm, messageInput);
    } else {
        console.error('Error: Missing user ID data attributes on the chat container.');
    }
}

/**
 * The core chat logic. Renamed to avoid conflict and indicate it's an internal helper.
 * @private
 */
function _initializeChat(currentUserId, otherUserId, chatBox, chatForm, messageInput) {
    // Auto-scroll to the bottom of the chat box
    chatBox.scrollTop = chatBox.scrollHeight;

    // Connect to the Socket.IO server
    const socket = io();

    // Create a unique room name for this pair of users
    const room = [currentUserId, otherUserId].sort().join('_');

    // --- Read Receipt Logic ---
    const unreadMessagesToMark = new Set();
    let markAsReadTimeout;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const messageDiv = entry.target;
                // Only mark received messages as read
                if (messageDiv.classList.contains('received')) {
                    const messageId = parseInt(messageDiv.id.split('-')[1], 10);
                    unreadMessagesToMark.add(messageId);
                    observer.unobserve(messageDiv); // Stop observing once it's been seen
                }
            }
        });

        // Debounce the server update to avoid spamming
        clearTimeout(markAsReadTimeout);
        markAsReadTimeout = setTimeout(sendReadReceipts, 1000); // Send update 1s after last message is seen
    }, { threshold: 0.8 }); // 0.8 means 80% of the element is visible
    // --------------------------

    // Pagination state
    let oldestMessageTimestamp = null;
    let isLoadingOlder = false;
    let hasMoreMessages = true;

    // Join the room when the page loads
    socket.on('connect', () => {
        console.log('Connected to WebSocket server.');
        socket.emit('join', { room: room });
    });

    // Listen for new messages from the server
    socket.on('message', (data) => {
        // Capture the timestamp of the very first (oldest) message loaded in any batch
        if (!oldestMessageTimestamp || new Date(data.timestamp) < new Date(oldestMessageTimestamp)) {
            oldestMessageTimestamp = data.timestamp;
        }

        // Remove the "No messages yet" placeholder if it exists
        const noMessagesEl = document.getElementById('noMessages');
        if (noMessagesEl) {
            noMessagesEl.remove();
        }

        // Create the new message element
        const messageDiv = document.createElement('div');
        messageDiv.id = `message-${data.id}`;
        const messageClass = String(data.sender_id) === String(currentUserId) ? 'sent' : 'received';
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

        // Add read receipt placeholder for sent messages
        if (messageClass === 'sent') {
            const receiptSpan = document.createElement('span');
            receiptSpan.className = 'read-receipt';
            receiptSpan.textContent = data.read_at ? '✓✓' : '✓';
            if (data.read_at) receiptSpan.classList.add('read');
            messageDiv.appendChild(receiptSpan);
        }

        if (messageClass === 'received') {
            observer.observe(messageDiv);
        }

        // Append the message to the chat box and scroll down
        chatBox.appendChild(messageDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
    });

    // Listen for older messages for pagination
    socket.on('older_messages', (messages) => {
        if (!messages || messages.length === 0) {
            hasMoreMessages = false;
            isLoadingOlder = false;
            return;
        }

        // The batch comes in chronological order, so the first item is the oldest overall
        oldestMessageTimestamp = messages[0].timestamp;

        const oldScrollHeight = chatBox.scrollHeight;
        const fragment = document.createDocumentFragment();

        messages.forEach((data) => {
            const messageDiv = document.createElement('div');
            messageDiv.id = `message-${data.id}`;
            const messageClass = String(data.sender_id) === String(currentUserId) ? 'sent' : 'received';
            messageDiv.className = `message ${messageClass}`;

            const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const contentNode = document.createTextNode(data.content + ' ');
            const timeSpan = document.createElement('span');
            timeSpan.className = 'time';
            timeSpan.textContent = time;

            messageDiv.appendChild(contentNode);
            messageDiv.appendChild(timeSpan);

            if (messageClass === 'sent') {
                const receiptSpan = document.createElement('span');
                receiptSpan.className = 'read-receipt';
                receiptSpan.textContent = data.read_at ? '✓✓' : '✓';
                if (data.read_at) receiptSpan.classList.add('read');
                messageDiv.appendChild(receiptSpan);
            }

            if (messageClass === 'received' && !data.read_at) {
                observer.observe(messageDiv);
            }

            fragment.appendChild(messageDiv);
        });

        const noMessagesEl = document.getElementById('noMessages');
        if (noMessagesEl) noMessagesEl.remove();

        chatBox.insertBefore(fragment, chatBox.firstChild);

        // Adjust scroll position so the user's view doesn't jump
        chatBox.scrollTop = chatBox.scrollHeight - oldScrollHeight;
        isLoadingOlder = false;
    });

    // Detect scroll to top to load older messages
    chatBox.addEventListener('scroll', () => {
        if (chatBox.scrollTop <= 5 && !isLoadingOlder && hasMoreMessages && oldestMessageTimestamp) {
            isLoadingOlder = true;
            socket.emit('load_older_messages', { room, beforeTimestamp: oldestMessageTimestamp });
        }
    });

    // Listen for confirmation that messages have been read by the other user
    socket.on('messages_read', ({ messageIds }) => {
        messageIds.forEach(id => {
            const messageDiv = document.getElementById(`message-${id}`);
            if (messageDiv) {
                const receiptSpan = messageDiv.querySelector('.read-receipt');
                if (receiptSpan) {
                    receiptSpan.textContent = '✓✓';
                    receiptSpan.classList.add('read'); // For styling (e.g., turning it blue)
                }
            }
        });
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

    function sendReadReceipts() {
        if (unreadMessagesToMark.size > 0) {
            socket.emit('mark_as_read', {
                messageIds: Array.from(unreadMessagesToMark),
                room: room,
                readerId: currentUserId // I am the one reading these messages
            });
            unreadMessagesToMark.clear();
        }
    }
}