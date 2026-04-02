document.addEventListener('DOMContentLoaded', () => {
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const chatBox = document.getElementById('chat-box');

    if (chatForm && chatInput && chatBox) {
        // Scroll to the bottom on initial load
        chatBox.scrollTop = chatBox.scrollHeight;

        chatForm.addEventListener('submit', (e) => {
            e.preventDefault(); // Prevent the form from reloading the page
            
            const messageText = chatInput.value.trim();
            if (messageText === '') return;

            // Create the main message container
            const messageDiv = document.createElement('div');
            messageDiv.classList.add('message', 'sent');
            
            // Add the text content
            messageDiv.textContent = messageText + ' ';

            // Create and append the timestamp based on your CSS
            const timeSpan = document.createElement('span');
            timeSpan.classList.add('time');
            const now = new Date();
            timeSpan.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            messageDiv.appendChild(timeSpan);

            // Append the new message to the chat box
            chatBox.appendChild(messageDiv);

            // Clear the input field and auto-scroll to the bottom
            chatInput.value = '';
            chatBox.scrollTop = chatBox.scrollHeight;

            // Simulate a reply with a typing indicator
            simulateReply(chatBox);
        });
    }

    function simulateReply(chatBox) {
        // 1. Create and show typing indicator
        const typingDiv = document.createElement('div');
        typingDiv.classList.add('typing-indicator');
        typingDiv.id = 'typing-indicator';
        
        // Add the 3 bouncing dots
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('div');
            dot.classList.add('dot');
            typingDiv.appendChild(dot);
        }
        
        chatBox.appendChild(typingDiv);
        chatBox.scrollTop = chatBox.scrollHeight;

        // 2. Wait 1.5 seconds, remove typing indicator, and append a simulated reply
        setTimeout(() => {
            const indicator = document.getElementById('typing-indicator');
            if (indicator) {
                indicator.remove();
            }

            // Create the simulated reply
            const replyDiv = document.createElement('div');
            replyDiv.classList.add('message', 'received');
            replyDiv.textContent = 'Thanks for reaching out! Let me check on that. ';

            const timeSpan = document.createElement('span');
            timeSpan.classList.add('time');
            const now = new Date();
            timeSpan.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            replyDiv.appendChild(timeSpan);
            chatBox.appendChild(replyDiv);
            chatBox.scrollTop = chatBox.scrollHeight;
        }, 1500);
    }
});