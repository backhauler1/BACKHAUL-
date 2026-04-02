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
        });
    }
});
