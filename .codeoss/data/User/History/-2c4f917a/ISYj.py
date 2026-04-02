import re
import time
import sqlite3
import json
import uuid
from flask import Blueprint, request, redirect, url_for, session, render_template, Response
import threading # New import

# Delay the import of main's utilities until after initialization
# to avoid circular dependency loops in Flask
from main import login_required, get_db

messaging_bp = Blueprint('messaging', __name__)

@messaging_bp.route('/inbox')

# In-memory store for typing status.
# Key: (sender_id, receiver_id) -> Value: {'status': 'typing'/'stopped', 'timestamp': float}
# This is simplified and would ideally use a more persistent/distributed store like Redis in production.
_typing_status = {}
TYPING_TIMEOUT_SECONDS = 5 # If no update in this time, assume user stopped typing
_contact_info_release_events = {} # To signal contact info release to SSE

def cleanup_typing_status():
    """Periodically cleans up expired typing statuses."""
    current_time = time.time()
    keys_to_remove = []
    for key, value in _typing_status.items():
        if value['status'] == 'typing' and (current_time - value['timestamp']) > TYPING_TIMEOUT_SECONDS:
            keys_to_remove.append(key)
    for key in keys_to_remove:
        # Set to 'stopped' first, so the stream can pick it up one last time
        _typing_status[key] = {'status': 'stopped', 'timestamp': current_time}

    threading.Timer(TYPING_TIMEOUT_SECONDS, cleanup_typing_status).start()

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
            # After sending a message, the user is no longer typing
            _typing_status[(user_id, other_user_id)] = {'status': 'stopped', 'timestamp': time.time()}
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

@messaging_bp.route('/typing_status/<other_user_id>', methods=['POST'])
@login_required
def update_typing_status(other_user_id):
    user_id = session['user_id']
    status = request.json.get('status') # 'typing' or 'stopped'

    if status in ['typing', 'stopped']:
        _typing_status[(user_id, other_user_id)] = {'status': status, 'timestamp': time.time()}
        return '', 204 # No content
    return 'Invalid status', 400


@messaging_bp.route('/stream/<other_user_id>')
@login_required
def stream(other_user_id):
    user_id = session['user_id']
    
    def event_stream():
        """A generator function that yields server-sent events."""
        last_message_timestamp = float(request.args.get('since', 0))
        last_typing_status = None # To track changes in typing status
        conn = get_db()
        while True:
            try:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT m.*, u.username as sender_name
                    FROM messages m
                    JOIN users u ON m.sender_id = u.user_id
                    WHERE ((m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?))
                      AND m.timestamp > ? 
                    ORDER BY m.timestamp ASC
                """, (user_id, other_user_id, other_user_id, user_id, last_message_timestamp))
                
                messages = cursor.fetchall()
                
                if messages:
                    for message in messages:
                        message_dict = dict(message)
                        sse_data = f"event: message\ndata: {json.dumps(message_dict)}\n\n" # Explicitly set event type
                        yield sse_data
                        last_message_timestamp = message_dict['timestamp']
                
                # 2. Check for typing status of the other user
                # The key for the other user typing to *this* user is (other_user_id, user_id)
                other_user_typing_key = (other_user_id, user_id)
                current_typing_status_entry = _typing_status.get(other_user_typing_key)

                is_other_user_typing = False
                if current_typing_status_entry and current_typing_status_entry['status'] == 'typing':
                    # Check if the typing status is still fresh
                    if (time.time() - current_typing_status_entry['timestamp']) < TYPING_TIMEOUT_SECONDS:
                        is_other_user_typing = True
                
                # Send typing status update only if it changed
                if is_other_user_typing != last_typing_status:
                    status_data = {'is_typing': is_other_user_typing}
                    sse_data = f"event: typing_status\ndata: {json.dumps(status_data)}\n\n" # Explicitly set event type
                    yield sse_data
                    last_typing_status = is_other_user_typing
                
                # 3. Check for contact info release events
                # This is a one-time event per match
                match_key = (user_id, other_user_id) # Assuming user_id is driver, other_user_id is shipper
                if match_key in _contact_info_release_events:
                    released_info = _contact_info_release_events.pop(match_key) # Get and remove
                    sse_data = f"event: contact_info_released\ndata: {json.dumps(released_info)}\n\n"
                    yield sse_data

                # Poll every 1 second for new messages, typing status, and contact info release
                time.sleep(1)
            except GeneratorExit:
                # The client has disconnected, stop the generator.
                return
            except Exception as e:
                print(f"Error in SSE stream: {e}") # Log error
                return

    return Response(event_stream(), mimetype='text/event-stream')

# Call cleanup_typing_status once to start the periodic cleanup
# This should ideally be done when the Flask app starts, not within the blueprint directly
# For the purpose of this exercise, we'll add a simple guard to prevent multiple timers.
# This guard is now in main.py, so we don't need it here.
# if not hasattr(messaging_bp, '_typing_cleanup_started'):
#     cleanup_typing_status()
#     messaging_bp._typing_cleanup_started = True

# Call cleanup_typing_status once to start the periodic cleanup
# This should ideally be done when the Flask app starts, not within the blueprint directly
# For the purpose of this exercise, we'll add a simple guard to prevent multiple timers.
if not hasattr(messaging_bp, '_typing_cleanup_started'):
    cleanup_typing_status()
    messaging_bp._typing_cleanup_started = True