from flask import Blueprint, render_template, request, redirect, url_for, session, current_app, flash
import sqlite3
import uuid
import time
import random
from werkzeug.security import generate_password_hash, check_password_hash
from itsdangerous import SignatureExpired, BadTimeSignature

# Import shared objects from the main application file.
# This works because main.py imports this blueprint at the end of its script,
# after these objects have been defined.
from main import (
    limiter, s, reset_serializer, verification_serializer,
    send_email, check_password_strength, DATABASE, login_required
)

# Create a Blueprint instance for authentication routes
auth_bp = Blueprint('auth', __name__)

@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form.get('username')
        email = request.form.get('email')
        password = request.form.get('password')
        role = request.form.get('role') # 'shipper' or 'transporter'
        privacy_policy = request.form.get('privacy_policy')

        if not privacy_policy:
            return "You must agree to the Privacy Policy and Terms of Service to register.", 400

        if not all([username, email, password, role]):
            return "Missing username, email, password, or role", 400
            
        is_valid, msg = check_password_strength(password)
        if not is_valid:
            return msg, 400

        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        
        cursor.execute("SELECT user_id FROM users WHERE username = ?", (username,))
        if cursor.fetchone():
            conn.close()
            return "Username already exists! Please choose another.", 409

        user_id = str(uuid.uuid4())
        password_hash = generate_password_hash(password)
        
        current_policy_version = "1.0"
        
        cursor.execute(
            "INSERT INTO users (user_id, username, email, password_hash, role, privacy_policy_agreed, agreed_to_policy_version, agreement_timestamp, is_email_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, username, email, password_hash, role, 1, current_policy_version, time.time(), 0)
        )
        conn.commit()
        conn.close()
        
        token = verification_serializer.dumps(user_id)
        verify_link = url_for('auth.verify_email', token=token, _external=True)
        
        text_content = f"Welcome to GottaBackhaul!\n\nPlease verify your email address by clicking the link below:\n{verify_link}\n\nThis link is valid for 24 hours."
        send_email(email, "Verify Your Email Address", text_content)
        
        return render_template('register_success.html', email=email)
        
    return render_template('register.html')

@auth_bp.route('/verify-email/<token>')
def verify_email(token):
    """Verifies the email address of a newly registered user."""
    try:
        user_id = verification_serializer.loads(token, max_age=86400)
    except (SignatureExpired, BadTimeSignature):
        return '<h1>Invalid or Expired Link</h1><p>The email verification link has expired or is invalid.</p>', 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET is_email_verified = 1 WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()

    return redirect(url_for('auth.login'))

@auth_bp.route('/resend-verification', methods=['GET', 'POST'])
@limiter.limit("3 per minute", methods=["POST"])
def resend_verification():
    """Allows a user to request a new email verification link."""
    if request.method == 'POST':
        email = request.form.get('email')
        if not email:
            return "Email is required.", 400

        conn = sqlite3.connect(DATABASE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE email = ?", (email,))
        user = cursor.fetchone()
        conn.close()

        if user and user['is_email_verified'] == 0:
            token = verification_serializer.dumps(user['user_id'])
            verify_link = url_for('auth.verify_email', token=token, _external=True)
            
            text_content = f"Welcome back to GottaBackhaul!\n\nPlease verify your email address by clicking the link below:\n{verify_link}\n\nThis link is valid for 24 hours."
            send_email(email, "Verify Your Email Address", text_content)
            
        return render_template('register_success.html', email=email, is_resend=True)

    return render_template('resend_verification.html')

@auth_bp.route('/login', methods=['GET', 'POST'])
@limiter.limit("5 per minute", methods=["POST"])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        conn = sqlite3.connect(DATABASE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
        user = cursor.fetchone()
        conn.close()
        
        if user and check_password_hash(user['password_hash'], password):
            if 'is_email_verified' in user.keys() and user['is_email_verified'] == 0:
                return f"Your email address is not verified. Please check your inbox for the verification link, or <a href='{url_for('auth.resend_verification')}'>click here to resend it</a>.", 403
                
            session.clear()
            session.permanent = True
            session['user_id'] = user['user_id']
            session['username'] = user['username']
            session['role'] = user['role']
            session['session_version'] = user['session_version'] or 1
            session['is_verified'] = False
            return redirect(url_for('dashboard'))
        
        current_app.logger.warning(f"Failed login attempt for username: '{username}' from IP: {request.remote_addr}")
        return "Invalid username or password", 401
        
    return render_template('login.html')

@auth_bp.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('index'))

@auth_bp.route('/logout-all', methods=['POST'])
@login_required
def logout_all():
    """Logs the user out of all devices by incrementing their session version."""
    user_id = session['user_id']
    
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET session_version = COALESCE(session_version, 1) + 1 WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()
    
    session.clear()
    return redirect(url_for('auth.login'))

@auth_bp.route('/magic-login', methods=['GET', 'POST'])
@limiter.limit("3 per minute", methods=["POST"])
def magic_login():
    """Provides a passwordless login option by sending a link to the user's email."""
    if request.method == 'POST':
        email = request.form.get('email')
        if not email:
            return "Email is required.", 400

        conn = sqlite3.connect(DATABASE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE email = ?", (email,))
        user = cursor.fetchone()
        conn.close()

        if user:
            token = s.dumps(user['user_id'])
            link = url_for('auth.verify_magic_link', token=token, _external=True)

            text_content = f"Hello,\n\nClick the link below to sign in to your GottaBackhaul account. This link is valid for 15 minutes.\n{link}\n\nIf you did not request this email, you can safely ignore it."
            html_content = f"""
                <!DOCTYPE html><html><head><title>GottaBackhaul Login</title></head><body>
                <h1>Your Magic Link is Here!</h1><p>Click the button below to securely sign in. This link will expire in 15 minutes.</p>
                <a href="{link}" style="background-color: #007bff; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 5px;">Sign In to GottaBackhaul</a>
                <p>If you did not request this email, you can safely ignore it.</p></body></html>
            """
            send_email(email, "Your GottaBackhaul Magic Login Link", text_content, html_content)
        
        return render_template('magic_link_sent.html', email=email)

    return render_template('magic_login.html')

@auth_bp.route('/verify-magic-link/<token>')
def verify_magic_link(token):
    """Verifies the magic link token and logs the user in."""
    try:
        user_id = s.loads(token, max_age=900)
    except (SignatureExpired, BadTimeSignature):
        return '<h1>Invalid or Expired Link</h1><p>The login link has expired or is invalid. Please request a new one.</p>', 400

    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()

    if user:
        if 'is_email_verified' in user.keys() and user['is_email_verified'] == 0:
            cursor.execute("UPDATE users SET is_email_verified = 1 WHERE user_id = ?", (user_id,))
            conn.commit()
        conn.close()

        session.clear()
        session.permanent = True
        session['user_id'] = user['user_id']
        session['username'] = user['username']
        session['role'] = user['role']
        session['session_version'] = user['session_version'] or 1
        session['is_verified'] = True
        return redirect(url_for('dashboard'))
    
    conn.close()
    return '<h1>User Not Found</h1><p>This user account no longer exists.</p>', 404

@auth_bp.route('/forgot-password', methods=['GET', 'POST'])
@limiter.limit("3 per minute", methods=["POST"])
def forgot_password():
    """Handles the forgot password request and sends a reset link."""
    if request.method == 'POST':
        email = request.form.get('email')
        if not email:
            return "Email is required.", 400

        conn = sqlite3.connect(DATABASE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE email = ?", (email,))
        user = cursor.fetchone()
        conn.close()

        if user:
            token = reset_serializer.dumps(user['user_id'])
            reset_link = url_for('auth.reset_password', token=token, _external=True)

            text_content = f"Hello,\n\nWe received a request to reset your password. Click the link below to choose a new one. This link is valid for 1 hour.\n{reset_link}\n\nIf you did not request this, please ignore this email."
            html_content = f"""
                <!DOCTYPE html><html><head><title>Reset Your Password</title></head><body>
                <h1>Reset Your Password</h1><p>Click the button below to choose a new password. This link will expire in 1 hour.</p>
                <a href="{reset_link}" style="background-color: #dc3545; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 5px;">Reset Password</a>
                <p>If you did not request a password reset, please ignore this email.</p></body></html>
            """
            send_email(email, "Reset your GottaBackhaul Password", text_content, html_content)
        
        return "If an account exists with that email, a password reset link has been sent to it.", 200

    return render_template('forgot_password.html')

@auth_bp.route('/reset-password/<token>', methods=['GET', 'POST'])
def reset_password(token):
    """Verifies the reset token and allows the user to set a new password."""
    try:
        user_id = reset_serializer.loads(token, max_age=3600)
    except (SignatureExpired, BadTimeSignature):
        return '<h1>Invalid or Expired Link</h1><p>The password reset link has expired or is invalid.</p>', 400

    if request.method == 'POST':
        new_password = request.form.get('password')
        if not new_password:
            return "Password is required.", 400
            
        is_valid, msg = check_password_strength(new_password)
        if not is_valid:
            return msg, 400

        password_hash = generate_password_hash(new_password)

        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET password_hash = ?, session_version = COALESCE(session_version, 1) + 1 WHERE user_id = ?", (password_hash, user_id))
        conn.commit()
        conn.close()

        return redirect(url_for('auth.login'))

    return render_template('reset_password.html', token=token)

@auth_bp.route('/verify-identity', methods=['GET', 'POST'])
@login_required
def verify_identity():
    """Handles the 2-step verification process before sensitive actions."""
    if request.method == 'POST':
        entered_pin = request.form.get('pin')
        if entered_pin and entered_pin == str(session.get('otp_pin')):
            session['is_verified'] = True
            session.pop('otp_pin', None)
            next_url = session.pop('next_url', url_for('dashboard'))
            return redirect(next_url)
        return "Invalid PIN. Please try again.", 401

    pin = str(random.randint(100000, 999999))
    session['otp_pin'] = pin
    
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("SELECT email FROM users WHERE user_id = ?", (session['user_id'],))
    row = cursor.fetchone()
    email = row[0] if row and row[0] else "your email"
    conn.close()

    print(f"\n*** EMAIL SENT TO {email} ***")
    print(f"*** Your Verification PIN is: {pin} ***\n")

    text_content = f"Your Verification PIN is: {pin}\n\nBest,\nYour App Team"
    send_email(email, "GottaBackhaul Verification PIN", text_content)

    return render_template('verify.html', email=email)

@auth_bp.route('/accept-bid/<int:bid_id>', methods=['POST'])
@login_required
def accept_bid(bid_id):
    """Accepts a bid, creates a match, and updates the load status."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # 1. Get bid and associated load, and verify ownership
    # Using a JOIN to get the load's owner (shipper_id) in one query
    cursor.execute("""
        SELECT b.id, b.load_id, b.driver_id, l.user_id as shipper_id, l.status as load_status, l.description as load_description
        FROM bids b
        JOIN loads l ON b.load_id = l.load_id
        WHERE b.id = ?
    """, (bid_id,))
    bid_info = cursor.fetchone()

    if not bid_info:
        flash("Bid not found.", "danger")
        conn.close()
        return redirect(url_for('main.dashboard'))

    if bid_info['shipper_id'] != session['user_id']:
        flash("You are not authorized to perform this action.", "danger")
        conn.close()
        # Returning 403 is more appropriate for authorization errors
        return redirect(url_for('main.dashboard')), 403

    load_id = bid_info['load_id']
    driver_id = bid_info['driver_id']
    shipper_id = bid_info['shipper_id']

    # Check if load is already matched to prevent race conditions
    # Assuming 'active' is the status for an open load. You might need to adjust this.
    if bid_info['load_status'] != 'active':
        flash("This load is no longer active and cannot be matched.", "warning")
        conn.close()
        return redirect(url_for('main.dashboard'))

    # Use a transaction to ensure all or no database changes are made
    try:
        # 2. Create a new match record.
        # The dashboard seems to expect 'accepted' as a status.
        cursor.execute("""
            INSERT INTO matches (load_id, shipper_id, driver_id, status, match_date)
            VALUES (?, ?, ?, 'accepted', CURRENT_TIMESTAMP)
        """, (load_id, shipper_id, driver_id))
        
        # 3. Update the load's status to 'matched' to take it off the public board.
        cursor.execute("UPDATE loads SET status = 'matched' WHERE load_id = ?", (load_id,))

        # 4. Clean up by deleting all bids for this now-matched load.
        cursor.execute("DELETE FROM bids WHERE load_id = ?", (load_id,))

        # 5. Create a notification for the driver
        notification_message = f"Your bid for the load '{bid_info['load_description']}' has been accepted!"
        notification_link = url_for('main.dashboard') # Link to their dashboard to see the new match
        cursor.execute("""
            INSERT INTO notifications (user_id, message, link, is_read)
            VALUES (?, ?, ?, 0)
        """, (driver_id, notification_message, notification_link))

        conn.commit()
        flash("Offer accepted! A new match has been created.", "success")
        
        # Notification has been created in the database.
        # The driver will see it on their dashboard.

    except sqlite3.Error as e:
        conn.rollback()
        current_app.logger.error(f"Database error on bid acceptance for bid_id {bid_id}: {e}")
        flash("A database error occurred while accepting the bid. Please try again.", "danger")
    finally:
        conn.close()

    return redirect(url_for('main.dashboard'))

@auth_bp.route('/decline-bid/<int:bid_id>', methods=['POST'])
@login_required
def decline_bid(bid_id):
    """Declines and deletes a specific bid."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # 1. Get bid and verify ownership of the associated load
    cursor.execute("""
        SELECT b.id, b.load_id, b.driver_id, l.user_id as shipper_id, l.description as load_description
        FROM bids b
        JOIN loads l ON b.load_id = l.load_id
        WHERE b.id = ?
    """, (bid_id,))
    bid_info = cursor.fetchone()

    if not bid_info:
        flash("Bid not found.", "danger")
        conn.close()
        return redirect(url_for('main.dashboard'))

    # Security check: only the load owner can decline bids on their load
    if bid_info['shipper_id'] != session['user_id']:
        flash("You are not authorized to perform this action.", "danger")
        conn.close()
        return redirect(url_for('main.dashboard')), 403

    # 2. Delete the bid from the database
    try:
        cursor.execute("DELETE FROM bids WHERE id = ?", (bid_id,))

        # 3. Create a notification for the driver
        notification_message = f"Unfortunately, your bid for the load '{bid_info['load_description']}' was declined."
        notification_link = url_for('main.available_loads') # Suggest they find other loads
        cursor.execute("""
            INSERT INTO notifications (user_id, message, link, is_read)
            VALUES (?, ?, ?, 0)
        """, (bid_info['driver_id'], notification_message, notification_link))

        conn.commit()
        flash("Offer declined successfully.", "success")
        
        # Notification has been created in the database.

    except sqlite3.Error as e:
        conn.rollback()
        current_app.logger.error(f"Database error on bid decline for bid_id {bid_id}: {e}")
        flash("An error occurred while declining the bid. Please try again.", "danger")
    finally:
        conn.close()

    return redirect(url_for('main.dashboard'))

@auth_bp.route('/notification/mark-read/<int:notification_id>', methods=['POST'])
@login_required
def mark_notification_read(notification_id):
    """Marks a single notification as read."""
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    # Ensure the user can only mark their own notifications as read
    cursor.execute("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", (notification_id, session['user_id']))
    conn.commit()
    conn.close()
    flash("Notification dismissed.", "info")
    # Redirect back to the page the user was on
    return redirect(request.referrer or url_for('main.dashboard'))