/*
    Initializes the chat functionality.
    This script acts as an entry point for the chat page, retrieving necessary
    user IDs from the DOM and invoking the real-time chat logic from map_loader.js.
*/
document.addEventListener('DOMContentLoaded', () => {
    // The main chat container should have data attributes for user IDs.
    // e.g., <div id="chatBox" data-current-user-id="123" data-other-user-id="456">...</div>
    const chatContainer = document.getElementById('chatBox');

    if (chatContainer) {
        const currentUserId = chatContainer.dataset.currentUserId;
        const otherUserId = chatContainer.dataset.otherUserId;

        if (currentUserId && otherUserId) {
            // Ensure the global initializeChat function from map_loader.js is available
            if (typeof initializeChat === 'function') {
                initializeChat(currentUserId, otherUserId);
            } else {
                console.error('Error: initializeChat function not found. Make sure map_loader.js is loaded before chat.js.');
            }
        } else {
            console.error('Error: Missing user ID data attributes on the chat container.');
        }
    }
});