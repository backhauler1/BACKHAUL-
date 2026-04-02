import re
import time
import sqlite3
import uuid
from flask import Blueprint, request, redirect, url_for, session, render_template

# Delay the import of main's utilities until after initialization
# to avoid circular dependency loops in Flask
from main import login_required, get_db

messaging_bp = Blueprint('messaging', __name__)

@messaging_bp.route('/inbox')
@login_required
def inbox():
    user_id = session['user_id']
    conn = get_db()
    cursor = conn.cursor()
    
    # Fetch the latest activity for each unique conversation
    cursor.execute("""
        SELECT 
            u.user_id as other_user_id,
            u.username as other_username,
            MAX(m.timestamp) as last_activity
        FROM messages m
        JOIN users u ON u.user_id = CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END
        WHERE m.sender_id = ? OR m.receiver_id = ?
        GROUP BY other_user_id
        ORDER BY last_activity DESC
    """, (user_id, user_id, user_id))
    conversations = cursor.fetchall()
    return render_template('inbox.html', conversations=conversations)

@messaging_bp.route('/chat/<other_user_id>', methods=['GET', 'POST'])
@login_required
def chat(other_user_id):
    user_id = session['user_id']
    conn = get_db()
    cursor = conn.cursor()

    def filter_message_content(text):
        """Redacts potential contact information from messages to prevent off-platform transactions."""
        text = re.sub(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', '[EMAIL REDACTED]', text)
        text = re.sub(r'\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}', '[PHONE REDACTED]', text)
        return text

    if request.method == 'POST':
        # Verify user identity before allowing them to send a message
        cursor.execute("SELECT id_verified FROM users WHERE user_id = ?", (user_id,))
        user_row = cursor.fetchone()
        if not user_row or not user_row['id_verified']:
            return "You must verify your identity securely via Stripe before you can send messages.", 403

        content = request.form.get('content')
        if content:
            filtered_content = filter_message_content(content)
            message_id = str(uuid.uuid4())
            cursor.execute("INSERT INTO messages (message_id, sender_id, receiver_id, content, timestamp) VALUES (?, ?, ?, ?, ?)",
                           (message_id, user_id, other_user_id, filtered_content, time.time()))
            conn.commit()
            return redirect(url_for('messaging.chat', other_user_id=other_user_id))

    # Check that the user we're chatting with exists
    cursor.execute("SELECT username FROM users WHERE user_id = ?", (other_user_id,))
    other_user = cursor.fetchone()
    if not other_user:
        return "User not found", 404

    # Fetch all messages between the current user and the other user
    cursor.execute("""
        SELECT m.*, u.username as sender_name
        FROM messages m
        JOIN users u ON m.sender_id = u.user_id
        WHERE (m.sender_id = ? AND m.receiver_id = ?)
           OR (m.sender_id = ? AND m.receiver_id = ?)
        ORDER BY m.timestamp ASC
    """, (user_id, other_user_id, other_user_id, user_id))
    messages = cursor.fetchall()
    
    return render_template('chat.html', messages=messages, other_user=other_user, other_user_id=other_user_id)