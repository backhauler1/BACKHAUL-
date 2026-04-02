/*
    Handles real-time chat functionality using WebSockets (Socket.IO).
*/

/**
 * Initializes the chat page functionality.
 * This function should be called when the DOM is ready on a page with the chat interface.
 */
export function initializeChatPage(socket) {
    const chatContainer = document.getElementById('chatBox');
    const chatForm = document.getElementById('chatForm');
    const messageInput = document.getElementById('messageInput');

    // Ensure elements exist and the Socket.IO library is loaded
    if (!chatContainer || !chatForm || !messageInput) {
        return; // Not a chat page, or elements are missing.
    }
    if (!socket) {
        console.error('Socket instance not provided to chat page.');
        return;
    }

    // When the user enters the chat page, clear any unread message badges from the navigation.
    clearUnreadMessageBadge();

    const currentUserId = chatContainer.dataset.currentUserId;
    const otherUserId = chatContainer.dataset.otherUserId;

    if (currentUserId && otherUserId) {
        _initializeChat(currentUserId, otherUserId, chatContainer, chatForm, messageInput, socket);
    } else {
        console.error('Error: Missing user ID data attributes on the chat container.');
    }
}

function clearUnreadMessageBadge() {
    // NOTE: The selector 'a[href*="chat"]' assumes your navigation link to the chat page contains "chat" in its href.
    const messagesLink = document.querySelector('a[href*="chat"]');
    if (messagesLink) {
        const badge = messagesLink.querySelector('.unread-badge');
        if (badge) badge.remove();
    }
}

/**
 * The core chat logic. Renamed to avoid conflict and indicate it's an internal helper.
 * @private
 */
function _initializeChat(currentUserId, otherUserId, chatBox, chatForm, messageInput, socket) {
    // Auto-scroll to the bottom of the chat box
    chatBox.scrollTop = chatBox.scrollHeight;

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

        // Handle typing indicator ordering so the indicator stays at the bottom
        const typingEl = document.getElementById('typing-indicator');
        if (typingEl) {
            if (messageClass === 'received') {
                typingEl.remove();
                chatBox.appendChild(messageDiv);
            } else {
                chatBox.insertBefore(messageDiv, typingEl);
            }
        } else {
            chatBox.appendChild(messageDiv);
        }

        // Scroll down
        chatBox.scrollTop = chatBox.scrollHeight;
    });

    // Listen for older messages for pagination
    socket.on('older_messages', (messages) => {
        // Remove the spinner first before we calculate the scroll height
        const spinner = document.getElementById('loading-older-spinner');
        if (spinner) spinner.remove();

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
            
            // Create and prepend the loading spinner
            const spinner = document.createElement('div');
            spinner.id = 'loading-older-spinner';
            spinner.style.cssText = 'text-align: center; padding: 10px; color: #888; font-size: 0.85em; font-style: italic;';
            spinner.innerHTML = '<span style="display:inline-block; animation: spin-chat 1s linear infinite;">↻</span> Loading older messages...';
            chatBox.insertBefore(spinner, chatBox.firstChild);
            
            if (!document.getElementById('chat-spin-keyframes')) {
                const style = document.createElement('style');
                style.id = 'chat-spin-keyframes';
                style.textContent = '@keyframes spin-chat { 100% { transform: rotate(360deg); } }';
                document.head.appendChild(style);
            }

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

    // Listen for typing status updates from the other user
    socket.on('typing_status', ({ userId, isTyping }) => {
        if (String(userId) === String(currentUserId)) return;

        let typingEl = document.getElementById('typing-indicator');
        if (isTyping) {
            if (!typingEl) {
                typingEl = document.createElement('div');
                typingEl.id = 'typing-indicator';
                typingEl.className = 'message received typing-indicator';
                typingEl.innerHTML = '<span style="font-style: italic; opacity: 0.7;">Typing...</span>';
                chatBox.appendChild(typingEl);
                chatBox.scrollTop = chatBox.scrollHeight;
            }
        } else if (typingEl) {
            typingEl.remove();
        }
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

            // Instantly clear the typing indicator when the message is sent
            clearTimeout(typingTimeout);
            isTyping = false;
            socket.emit('typing_status', { room, userId: currentUserId, isTyping: false });
        }
    });

    // Detect typing to emit status to the server
    let typingTimeout;
    let isTyping = false;
    messageInput.addEventListener('input', () => {
        if (!isTyping) {
            isTyping = true;
            socket.emit('typing_status', { room, userId: currentUserId, isTyping: true });
        }
        
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            isTyping = false;
            socket.emit('typing_status', { room, userId: currentUserId, isTyping: false });
        }, 1500);
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