import os
import re
import time
import smtplib
from email.message import EmailMessage
import sqlite3
import base64
import json
import uuid
import random
import stripe
import datetime
import math
import urllib.parse
import urllib.request
import csv
import io
from datetime import timedelta
from functools import wraps
from flask import Flask, request, jsonify, render_template, session, redirect, url_for, send_from_directory, Response
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix
from itsdangerous import URLSafeTimedSerializer, SignatureExpired, BadTimeSignature
from dotenv import load_dotenv
from webauthn import (
    generate_registration_options,
    verify_registration_response,
    generate_authentication_options,
    verify_authentication_response,
    options_to_json
)
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

# Load environment variables from a .env file
load_dotenv()

# --- Database Setup ---
DATABASE = 'trucking.db'

def init_db():
    """Initializes the database and creates tables if they don't exist."""
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    # Table for user accounts
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('shipper', 'transporter')),
            session_version INTEGER DEFAULT 1
        );
    """)
    
    # Safely attempt to add the email column to existing databases
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN email TEXT")
    except sqlite3.OperationalError:
        pass # Column already exists
        
    # Safely attempt to add the session_version column to existing databases
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN session_version INTEGER DEFAULT 1")
    except sqlite3.OperationalError:
        pass

    # Safely attempt to add broker verification columns
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN dot_number TEXT")
        cursor.execute("ALTER TABLE users ADD COLUMN is_broker_verified INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass

    # Safely attempt to add profile columns if they don't exist
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN bio TEXT")
        cursor.execute("ALTER TABLE users ADD COLUMN contact_info TEXT")
    except sqlite3.OperationalError:
        pass
        
    # Safely attempt to add the mc_certificate_path column
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN mc_certificate_path TEXT")
    except sqlite3.OperationalError:
        pass
        
    # Safely attempt to add alternative trust columns for everyday travelers
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN insurance_path TEXT")
        cursor.execute("ALTER TABLE users ADD COLUMN drivers_license_path TEXT")
        cursor.execute("ALTER TABLE users ADD COLUMN is_traveler_verified INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass
        
    # Safely attempt to add the expiration date column
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN insurance_expiration_date TEXT")
    except sqlite3.OperationalError:
        pass
        
    # Safely attempt to add Stripe Connect and Verification columns
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN stripe_account_id TEXT")
        cursor.execute("ALTER TABLE users ADD COLUMN id_verified INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass
        
    # Safely attempt to add GDPR consent columns
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN privacy_policy_agreed INTEGER DEFAULT 0")
        cursor.execute("ALTER TABLE users ADD COLUMN agreed_to_policy_version TEXT")
        cursor.execute("ALTER TABLE users ADD COLUMN agreement_timestamp REAL")
    except sqlite3.OperationalError:
        pass
        
    # Safely attempt to add email verification column
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN is_email_verified INTEGER DEFAULT 0")
        cursor.execute("UPDATE users SET is_email_verified = 1") # Grandfather existing users
    except sqlite3.OperationalError:
        pass

    # Table for load information
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS loads (
            load_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            description TEXT,
            weight TEXT,
            dimensions TEXT,
            pickup TEXT,
            delivery TEXT,
            offer TEXT,
            timestamp REAL,
            shipping_date TEXT,
            payment_status TEXT DEFAULT 'unpaid',
            FOREIGN KEY (user_id) REFERENCES users (user_id)
        );
    """)
    
    # Safely attempt to add the stripe_dispute_id column to existing databases
    try:
        cursor.execute("ALTER TABLE loads ADD COLUMN stripe_dispute_id TEXT")
    except sqlite3.OperationalError:
        pass
    
    # Safely attempt to add the ip_address column to existing databases
    try:
        cursor.execute("ALTER TABLE loads ADD COLUMN ip_address TEXT")
    except sqlite3.OperationalError:
        pass

    # Safely attempt to add the is_flagged column to existing databases
    try:
        cursor.execute("ALTER TABLE loads ADD COLUMN is_flagged INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass

    # Safely attempt to add the admin_notes column to track internal notes
    try:
        cursor.execute("ALTER TABLE loads ADD COLUMN admin_notes TEXT")
    except sqlite3.OperationalError:
        pass

    # Table for real-time location tracking
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS locations (
            load_id TEXT PRIMARY KEY,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            timestamp REAL NOT NULL,
            FOREIGN KEY (load_id) REFERENCES loads (load_id)
        );
    """)
    
    # Table for delivery confirmations (signatures or pictures)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS delivery_proofs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            load_id TEXT NOT NULL,
            signature TEXT,
            image_path TEXT,
            timestamp REAL NOT NULL,
            FOREIGN KEY (load_id) REFERENCES loads (load_id)
        );
    """)

    # Safely attempt to add latitude and longitude columns to delivery_proofs
    try:
        cursor.execute("ALTER TABLE delivery_proofs ADD COLUMN latitude REAL")
        cursor.execute("ALTER TABLE delivery_proofs ADD COLUMN longitude REAL")
    except sqlite3.OperationalError:
        pass

    # Table for dispute evidence
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS dispute_evidence (
            evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
            load_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            comments TEXT,
            file_path TEXT,
            timestamp REAL NOT NULL,
            FOREIGN KEY (load_id) REFERENCES loads (load_id),
            FOREIGN KEY (user_id) REFERENCES users (user_id)
        );
    """)

    # Table for available vehicles/drivers (trucks, personal cars, vans, etc.)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS vehicles (
            vehicle_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            vehicle_type TEXT,
            departure_city TEXT,
            destination_city TEXT,
            start_date TEXT,
            end_date TEXT,
            max_weight TEXT,
            max_dimensions TEXT,
            timestamp REAL,
            FOREIGN KEY (user_id) REFERENCES users (user_id)
        );
    """)

    # Table to link a specific load to a specific vehicle/driver
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS matches (
            match_id TEXT PRIMARY KEY,
            load_id TEXT NOT NULL,
            vehicle_id TEXT NOT NULL,
            timestamp REAL NOT NULL,
            FOREIGN KEY (load_id) REFERENCES loads (load_id),
            FOREIGN KEY (vehicle_id) REFERENCES vehicles (vehicle_id)
        );
    """)

    # Table for reviews and ratings
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS reviews (
            review_id TEXT PRIMARY KEY,
            match_id TEXT NOT NULL,
            reviewer_id TEXT NOT NULL,
            reviewee_id TEXT NOT NULL,
            rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
            comment TEXT,
            timestamp REAL NOT NULL,
            FOREIGN KEY (match_id) REFERENCES matches (match_id),
            FOREIGN KEY (reviewer_id) REFERENCES users (user_id),
            FOREIGN KEY (reviewee_id) REFERENCES users (user_id)
        );
    """)

    # Table for direct messages
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            message_id TEXT PRIMARY KEY,
            sender_id TEXT NOT NULL,
            receiver_id TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp REAL NOT NULL,
            FOREIGN KEY (sender_id) REFERENCES users (user_id),
            FOREIGN KEY (receiver_id) REFERENCES users (user_id)
        );
    """)
    
    # Table for storing WebAuthn Passkeys
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS passkeys (
            credential_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            public_key BLOB NOT NULL,
            sign_count INTEGER NOT NULL DEFAULT 0,
            transports TEXT,
            FOREIGN KEY (user_id) REFERENCES users (user_id)
        );
    """)
    
    conn.commit()
    conn.close()

# --- Flask App Setup ---
# Define a folder to store uploads
UPLOAD_FOLDER = 'delivery_proofs'

app = Flask(__name__)
app.secret_key = os.urandom(24) # Needed for session management
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
# Keep users logged in for 30 days for easy browsing
app.permanent_session_lifetime = timedelta(days=30)

# --- Security Configuration ---
# Ensure FLASK_ENV=production is set in your server's environment or .env file
IS_PRODUCTION = os.environ.get('FLASK_ENV') == 'production'

# Secure cookie settings
app.config['SESSION_COOKIE_SECURE'] = IS_PRODUCTION
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

if IS_PRODUCTION:
    # Trust headers like X-Forwarded-Proto from the reverse proxy (e.g., Nginx)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

@app.before_request
def enforce_https():
    """Force HTTPS redirects in production."""
    if IS_PRODUCTION and not request.is_secure:
        url = request.url.replace('http://', 'https://', 1)
        return redirect(url, code=301)

# --- Rate Limiting Setup ---
limiter = Limiter(
    get_remote_address,
    app=app,
    storage_uri="memory://"
)

# Serializer for generating secure, timed tokens for magic links
s = URLSafeTimedSerializer(app.secret_key, salt='magic-link-salt')
# Serializer for password resets
reset_serializer = URLSafeTimedSerializer(app.secret_key, salt='password-reset-salt')
# Serializer for email updates
email_update_serializer = URLSafeTimedSerializer(app.secret_key, salt='email-update-salt')
# Serializer for new account email verification
verification_serializer = URLSafeTimedSerializer(app.secret_key, salt='email-verification-salt')

# --- WebAuthn / Passkeys Setup ---
# Important: In production, RP_ID should be your actual domain (e.g., "gottabackhaul.com")
# and ORIGIN should be "https://gottabackhaul.com"
RP_ID = "localhost" 
RP_NAME = "GottaBackhaul"
ORIGIN = "http://localhost:5000" 

# --- Stripe Setup ---
# It's best practice to use environment variables for secret keys
stripe.api_key = os.environ.get('STRIPE_SECRET_KEY', "YOUR_STRIPE_SECRET_KEY")
stripe.api_key = os.environ.get('STRIPE_SECRET_KEY')

@app.template_filter('datetimeformat')
def datetimeformat(value, format='%Y-%m-%d %H:%M'):
    """Formats a timestamp into a human-readable string."""
    if value is None:
        return ""
    return datetime.datetime.fromtimestamp(value).strftime(format)

# --- Email Helper ---
def send_email(to_email, subject, text_content, html_content=None, cc_email=None, bcc_email=None):
    """A helper function to centralize email sending logic."""
    sender_email = "gottabackhaul@gmail.com"
    sender_password = os.environ.get("GMAIL_APP_PASSWORD")
    
    if not sender_password:
        print(f"Warning: GMAIL_APP_PASSWORD not set. Cannot send email to {to_email}")
        return False
        
    try:
        msg = EmailMessage()
        msg['Subject'] = subject
        msg['From'] = sender_email
        msg['To'] = to_email

        if cc_email:
            if isinstance(cc_email, list):
                msg['Cc'] = ', '.join(cc_email)
            else:
                msg['Cc'] = cc_email

        if bcc_email:
            if isinstance(bcc_email, list):
                msg['Bcc'] = ', '.join(bcc_email)
            else:
                msg['Bcc'] = bcc_email
        
        msg.set_content(text_content)
        if html_content:
            try:
                msg.add_alternative(html_content, subtype='html')
            except Exception as html_err:
                print(f"Warning: Failed to attach HTML content, falling back to text-only. Error: {html_err}")

        server = smtplib.SMTP_SSL('smtp.gmail.com', 465)
        server.login(sender_email, sender_password)
        server.send_message(msg)
        server.quit()
        print(f"Successfully sent email to {to_email}: {subject}")
        return True
    except Exception as e:
        print(f"Failed to send email to {to_email}: {e}")
        return False

# --- Password Validation ---
def check_password_strength(password):
    """Validates that a password meets minimum strength requirements."""
    if len(password) < 8:
        return False, "Password must be at least 8 characters long."
    if not re.search(r"[A-Z]", password):
        return False, "Password must contain at least one uppercase letter."
    if not re.search(r"[a-z]", password):
        return False, "Password must contain at least one lowercase letter."
    if not re.search(r"[0-9]", password):
        return False, "Password must contain at least one number."
    if not re.search(r"[!@#$%^&*(),.?\":{}|<>]", password):
        return False, "Password must contain at least one special character."
    return True, ""


# --- Location Validation Helpers ---
def calculate_distance(lat1, lon1, lat2, lon2):
    """Calculates the distance between two GPS coordinates in miles using the Haversine formula."""
    R = 3958.8 # Radius of earth in miles
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = math.sin(dLat/2) * math.sin(dLat/2) + \
        math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * \
        math.sin(dLon/2) * math.sin(dLon/2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c

def geocode_address(address):
    """Geocodes an address to lat/lon using OpenStreetMap's Nominatim API."""
    try:
        url = f"https://nominatim.openstreetmap.org/search?q={urllib.parse.quote(address)}&format=json&limit=1"
        req = urllib.request.Request(url, headers={'User-Agent': 'GottaBackhaulApp/1.0'})
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
            if data:
                return float(data[0]['lat']), float(data[0]['lon'])
    except Exception as e:
        print(f"Geocoding failed for '{address}': {e}")
    return None, None

def verify_fmcsa_broker(dot_number):
    """
    Verifies a USDOT number against an FMCSA data provider.
    Returns True if the entity is an active, authorized freight broker.
    """
    if not dot_number:
        return False
        
    try:
        # Example using the 'SaferWeb API' via RapidAPI
        url = f"https://saferweb-api.p.rapidapi.com/CompanySnapshot/{urllib.parse.quote(dot_number)}"
        headers = {
            "X-RapidAPI-Key": os.environ.get("RAPIDAPI_KEY", "your_rapidapi_key_here"),
            "X-RapidAPI-Host": "saferweb-api.p.rapidapi.com"
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode())
            
            # Check if the company is an active broker based on the API's JSON structure
            is_active = data.get('operating_status') == 'ACTIVE'
            is_broker = 'BROKER' in str(data.get('entity_type', '')).upper()
            
            return is_active and is_broker
    except Exception as e:
        print(f"FMCSA Broker Verification failed for DOT '{dot_number}': {e}")
    return False

def get_ip_location(ip_address):
    """Fetches the latitude and longitude of an IP address using a free API."""
    # For local development, 127.0.0.1 won't return a physical location
    if ip_address in ['127.0.0.1', '::1', None]:
        print("Local or missing IP detected, skipping IP geolocation.")
        return None, None
        
    try:
        url = f"http://ip-api.com/json/{ip_address}"
        req = urllib.request.Request(url, headers={'User-Agent': 'GottaBackhaulApp/1.0'})
        with urllib.request.urlopen(req, timeout=3) as response:
            data = json.loads(response.read().decode())
            if data and data.get('status') == 'success':
                return float(data['lat']), float(data['lon'])
    except Exception as e:
        print(f"IP Geolocation failed for '{ip_address}': {e}")
    return None, None

# --- User Authentication Decorator ---
def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login', next=request.url))
            
        # Verify session version to support logging out of all devices
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("SELECT session_version FROM users WHERE user_id = ?", (session['user_id'],))
        row = cursor.fetchone()
        conn.close()
        
        if not row or session.get('session_version', 1) != (row[0] or 1):
            session.clear()
            return redirect(url_for('login', next=request.url))
            
        return f(*args, **kwargs)
    return decorated_function

# --- Admin Authentication Decorator ---
def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login', next=request.url))
            
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("SELECT email FROM users WHERE user_id = ?", (session['user_id'],))
        row = cursor.fetchone()
        conn.close()
        
        admin_email = os.environ.get("ADMIN_EMAIL", "gottabackhaul@gmail.com")
        if not row or row[0] != admin_email:
            return "Unauthorized: Admins only.", 403
            
        return f(*args, **kwargs)
    return decorated_function

# --- Two-Step Verification Decorator ---
def verification_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login', next=request.url))
        if not session.get('is_verified'):
            session['next_url'] = request.url
            return redirect(url_for('verify_identity'))
        return f(*args, **kwargs)
    return decorated_function

# --- Custom Error Handlers ---
@app.errorhandler(429)
def ratelimit_handler(e):
    return render_template('429.html', error_description=e.description), 429

@app.errorhandler(404)
def page_not_found(e):
    return render_template('404.html'), 404

@app.errorhandler(500)
def internal_server_error(e):
    return render_template('500.html'), 500

@app.route('/')
def index():
    # Pass session info to the template to conditionally show links
    return render_template('index.html', session=session)

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form.get('username')
        email = request.form.get('email')
        password = request.form.get('password')
        role = request.form.get('role') # 'shipper' or 'transporter'
        privacy_policy = request.form.get('privacy_policy')

        if not privacy_policy:
            # In a real app, you'd re-render the form with an error
            return "You must agree to the Privacy Policy and Terms of Service to register.", 400

        if not all([username, email, password, role]):
            return "Missing username, email, password, or role", 400
            
        # Validate password strength
        is_valid, msg = check_password_strength(password)
        if not is_valid:
            return msg, 400

        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        
        # Check if username already exists
        cursor.execute("SELECT user_id FROM users WHERE username = ?", (username,))
        if cursor.fetchone():
            conn.close()
            # Ideally, you'd re-render the form with an error message
            return "Username already exists! Please choose another.", 409

        user_id = str(uuid.uuid4())
        password_hash = generate_password_hash(password)
        
        # Define the current version of your policy. This should be updated when your policy changes.
        current_policy_version = "1.0"
        
        cursor.execute(
            "INSERT INTO users (user_id, username, email, password_hash, role, privacy_policy_agreed, agreed_to_policy_version, agreement_timestamp, is_email_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, username, email, password_hash, role, 1, current_policy_version, time.time(), 0)
        )
        conn.commit()
        conn.close()
        
        # Generate verification token
        token = verification_serializer.dumps(user_id)
        verify_link = url_for('verify_email', token=token, _external=True)
        
        # Send verification email
        text_content = f"Welcome to GottaBackhaul!\n\nPlease verify your email address by clicking the link below:\n{verify_link}\n\nThis link is valid for 24 hours."
        send_email(email, "Verify Your Email Address", text_content)
        
        return render_template('register_success.html', email=email)
        
    return render_template('register.html')

@app.route('/verify-email/<token>')
def verify_email(token):
    """Verifies the email address of a newly registered user."""
    try:
        # Token valid for 24 hours (86400 seconds)
        user_id = verification_serializer.loads(token, max_age=86400)
    except (SignatureExpired, BadTimeSignature):
        return '<h1>Invalid or Expired Link</h1><p>The email verification link has expired or is invalid.</p>', 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET is_email_verified = 1 WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()

    return redirect(url_for('login'))

@app.route('/resend-verification', methods=['GET', 'POST'])
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
            # Generate new verification token
            token = verification_serializer.dumps(user['user_id'])
            verify_link = url_for('verify_email', token=token, _external=True)
            
            text_content = f"Welcome back to GottaBackhaul!\n\nPlease verify your email address by clicking the link below:\n{verify_link}\n\nThis link is valid for 24 hours."
            send_email(email, "Verify Your Email Address", text_content)
            
        # Reusing your success template to avoid letting attackers know if an email exists
        return render_template('register_success.html', email=email, is_resend=True)

    return render_template('resend_verification.html')

@app.route('/login', methods=['GET', 'POST'])
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
                return f"Your email address is not verified. Please check your inbox for the verification link, or <a href='{url_for('resend_verification')}'>click here to resend it</a>.", 403
                
            session.clear()
            session.permanent = True # Keep them logged in automatically
            session['user_id'] = user['user_id']
            session['username'] = user['username']
            session['role'] = user['role']
            session['session_version'] = user['session_version'] or 1
            session['is_verified'] = False # Reset verification on new login
            return redirect(url_for('dashboard'))
        
        # Re-render login form with an error
        return "Invalid username or password", 401
        
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('index'))

@app.route('/logout-all', methods=['POST'])
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
    return redirect(url_for('login'))

@app.route('/magic-login', methods=['GET', 'POST'])
@limiter.limit("3 per minute", methods=["POST"])
def magic_login():
    """Provides a passwordless login option by sending a link to the user's email."""
    if request.method == 'POST':
        email = request.form.get('email')
        if not email:
            # In a real app, you'd re-render the form with an error
            return "Email is required.", 400

        conn = sqlite3.connect(DATABASE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE email = ?", (email,))
        user = cursor.fetchone()
        conn.close()

        if user:
            # Generate a timed, signed token containing the user's ID
            token = s.dumps(user['user_id'])
            link = url_for('verify_magic_link', token=token, _external=True)

            text_content = f"""
Hello,

Click the link below to sign in to your GottaBackhaul account. This link is valid for 15 minutes.
{link}

If you did not request this email, you can safely ignore it.
"""

            html_content = f"""
<!DOCTYPE html>
<html>
<head>
<title>GottaBackhaul Login</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 20px; background-color: #f4f7f6; color: #333; }}
  .container {{ background-color: #ffffff; padding: 30px; border-radius: 8px; max-width: 540px; margin: 20px auto; border: 1px solid #e0e0e0; }}
  h1 {{ color: #0d1a26; font-size: 24px; }}
  p {{ line-height: 1.6; }}
  .button-container {{ text-align: center; margin: 30px 0; }}
  .button {{ background-color: #007bff; color: #ffffff; padding: 14px 28px; text-align: center; text-decoration: none; display: inline-block; border-radius: 5px; font-size: 16px; font-weight: bold; }}
  .link-fallback {{ font-size: 12px; color: #555; word-break: break-all; }}
  .footer {{ margin-top: 20px; text-align: center; color: #888; font-size: 12px; }}
</style>
</head>
<body>
  <div class="container">
    <h1>Your Magic Link is Here!</h1>
    <p>Hello,</p>
    <p>Click the button below to securely sign in to your GottaBackhaul account. This link will expire in 15 minutes.</p>
    <div class="button-container">
      <a href="{link}" class="button">Sign In to GottaBackhaul</a>
    </div>
    <p>If the button above doesn't work, you can copy and paste this link into your browser:</p>
    <p class="link-fallback"><a href="{link}">{link}</a></p>
    <hr style="border: 0; border-top: 1px solid #e0e0e0; margin: 20px 0;">
    <p style="font-size: 12px; color: #555;">If you did not request this email, you can safely ignore it. No changes have been made to your account.</p>
  </div>
  <div class="footer">
    <p>&copy; {datetime.datetime.now().year} GottaBackhaul. All rights reserved.</p>
  </div>
</body>
</html>
"""
            send_email(email, "Your GottaBackhaul Magic Login Link", text_content, html_content)
        
        # IMPORTANT: Always show the same message to prevent user enumeration attacks.
        return render_template('magic_link_sent.html', email=email)

    return render_template('magic_login.html')

@app.route('/verify-magic-link/<token>')
def verify_magic_link(token):
    """Verifies the magic link token and logs the user in."""
    try:
        # Verify the token's signature and that it hasn't expired (max_age is in seconds)
        user_id = s.loads(token, max_age=900) # 15 minutes
    except (SignatureExpired, BadTimeSignature):
        return '<h1>Invalid or Expired Link</h1><p>The login link has expired or is invalid. Please request a new one.</p>', 400

    # The token is valid, log the user in
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()

    if user:
        # Implicitly permanently verify their email since they used a magic link
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
        # They proved ownership of the email, so we can consider them verified for this session
        session['is_verified'] = True
        return redirect(url_for('dashboard'))
    
    conn.close()
    return '<h1>User Not Found</h1><p>This user account no longer exists.</p>', 404

@app.route('/forgot-password', methods=['GET', 'POST'])
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
            # Generate a secure token for password reset
            token = reset_serializer.dumps(user['user_id'])
            reset_link = url_for('reset_password', token=token, _external=True)

            text_content = f"""
Hello,

We received a request to reset the password for your GottaBackhaul account. Click the link below to choose a new password. This link is valid for 1 hour.
{reset_link}

If you did not request a password reset, please safely ignore this email.
"""

            html_content = f"""
<!DOCTYPE html>
<html>
<head>
<title>Reset Your Password</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 20px; background-color: #f4f7f6; color: #333; }}
  .container {{ background-color: #ffffff; padding: 30px; border-radius: 8px; max-width: 540px; margin: 20px auto; border: 1px solid #e0e0e0; }}
  h1 {{ color: #0d1a26; font-size: 24px; }}
  p {{ line-height: 1.6; }}
  .button-container {{ text-align: center; margin: 30px 0; }}
  .button {{ background-color: #dc3545; color: #ffffff; padding: 14px 28px; text-align: center; text-decoration: none; display: inline-block; border-radius: 5px; font-size: 16px; font-weight: bold; }}
  .link-fallback {{ font-size: 12px; color: #555; word-break: break-all; }}
  .footer {{ margin-top: 20px; text-align: center; color: #888; font-size: 12px; }}
</style>
</head>
<body>
  <div class="container">
    <h1>Reset Your Password</h1>
    <p>Hello,</p>
    <p>We received a request to reset the password for your GottaBackhaul account. Click the button below to choose a new password. This link will expire in 1 hour.</p>
    <div class="button-container">
      <a href="{reset_link}" class="button">Reset Password</a>
    </div>
    <p>If the button above doesn't work, you can copy and paste this link into your browser:</p>
    <p class="link-fallback"><a href="{reset_link}">{reset_link}</a></p>
    <hr style="border: 0; border-top: 1px solid #e0e0e0; margin: 20px 0;">
    <p style="font-size: 12px; color: #555;">If you did not request a password reset, please safely ignore this email. Your password will remain unchanged.</p>
  </div>
  <div class="footer">
    <p>&copy; {datetime.datetime.now().year} GottaBackhaul. All rights reserved.</p>
  </div>
</body>
</html>
"""
            send_email(email, "Reset your GottaBackhaul Password", text_content, html_content)
        
        # Always return a generic success message to prevent user enumeration
        return "If an account exists with that email, a password reset link has been sent to it.", 200

    return render_template('forgot_password.html')

@app.route('/reset-password/<token>', methods=['GET', 'POST'])
def reset_password(token):
    """Verifies the reset token and allows the user to set a new password."""
    try:
        # Verify token, valid for 1 hour (3600 seconds)
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
        # Update the password and implicitly log them out of any other devices for security
        cursor.execute("UPDATE users SET password_hash = ?, session_version = COALESCE(session_version, 1) + 1 WHERE user_id = ?", (password_hash, user_id))
        conn.commit()
        conn.close()

        return redirect(url_for('login'))

    return render_template('reset_password.html', token=token)

@app.route('/verify-identity', methods=['GET', 'POST'])
@login_required
def verify_identity():
    """Handles the 2-step verification process before sensitive actions."""
    if request.method == 'POST':
        entered_pin = request.form.get('pin')
        if entered_pin and entered_pin == str(session.get('otp_pin')):
            session['is_verified'] = True
            session.pop('otp_pin', None) # Clear the PIN from session
            next_url = session.pop('next_url', url_for('dashboard'))
            return redirect(next_url)
        return "Invalid PIN. Please try again.", 401

    # GET request: Generate and "send" the PIN
    pin = str(random.randint(100000, 999999))
    session['otp_pin'] = pin
    
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("SELECT email FROM users WHERE user_id = ?", (session['user_id'],))
    row = cursor.fetchone()
    email = row[0] if row and row[0] else "your email"
    conn.close()

    # Simulate sending an email (You would plug SendGrid/Mailgun in here later)
    print(f"\n*** EMAIL SENT TO {email} ***")
    print(f"*** Your Verification PIN is: {pin} ***\n")

    text_content = f"Your Verification PIN is: {pin}\n\nBest,\nYour App Team"
    send_email(email, "GottaBackhaul Verification PIN", text_content)

    return render_template('verify.html', email=email)

@app.route('/generate-registration-options', methods=['POST'])
@login_required
def generate_registration_opts():
    """Generates a secure challenge for the user's device to create a Passkey."""
    user_id = session['user_id']
    username = session['username']

    # 1. Generate the WebAuthn registration options
    options = generate_registration_options(
        rp_id=RP_ID,
        rp_name=RP_NAME,
        user_id=user_id.encode('utf-8'),
        user_name=username,
    )
    
    # 2. Save the challenge in the session to verify it later
    # We encode it as base64url so it safely fits in the session cookie
    challenge_b64 = base64.urlsafe_b64encode(options.challenge).decode('utf-8').rstrip('=')
    session['webauthn_registration_challenge'] = challenge_b64
    
    # 3. Return the options to the frontend JavaScript
    return options_to_json(options)

@app.route('/verify-registration', methods=['POST'])
@login_required
def verify_registration():
    """Verifies the signed response from the user's device and saves the Passkey."""
    registration_response = request.json
    challenge_b64 = session.get('webauthn_registration_challenge')
    
    if not challenge_b64:
        return jsonify({"error": "No active registration challenge found"}), 400
        
    try:
        # Re-pad the base64url challenge and decode it
        challenge_bytes = base64.urlsafe_b64decode(challenge_b64 + '=' * (4 - len(challenge_b64) % 4))
        
        # Verify the signature from the device
        verification = verify_registration_response(
            credential=registration_response,
            expected_challenge=challenge_bytes,
            expected_origin=ORIGIN,
            expected_rp_id=RP_ID
        )
        
        # If verification succeeds, we save the passkey to the database
        cred_id_str = base64.urlsafe_b64encode(verification.credential_id).decode('utf-8').rstrip('=')
        
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO passkeys (credential_id, user_id, public_key, sign_count) VALUES (?, ?, ?, ?)",
            (cred_id_str, session['user_id'], verification.credential_public_key, verification.sign_count)
        )
        conn.commit()
        conn.close()
        
        return jsonify({"status": "ok", "message": "Passkey registered successfully!"})
        
    except Exception as e:
        print(f"Passkey registration failed: {e}")
        return jsonify({"error": "Registration failed"}), 400

@app.route('/generate-auth-options', methods=['POST'])
@limiter.limit("5 per minute")
def generate_auth_opts():
    """Generates a secure challenge for the user's device to log in."""
    data = request.json
    username = data.get('username')

    if not username:
        return jsonify({"error": "Username is required to use a passkey."}), 400

    # Generate the WebAuthn authentication options
    options = generate_authentication_options(
        rp_id=RP_ID,
    )
    
    # Save challenge and username in session to verify it later
    challenge_b64 = base64.urlsafe_b64encode(options.challenge).decode('utf-8').rstrip('=')
    session['webauthn_auth_challenge'] = challenge_b64
    session['webauthn_auth_username'] = username
    
    return options_to_json(options)

@app.route('/verify-auth', methods=['POST'])
def verify_auth():
    """Verifies the signed response from the user's device and logs them in."""
    auth_response = request.json
    challenge_b64 = session.get('webauthn_auth_challenge')
    username = session.get('webauthn_auth_username')
    
    if not challenge_b64 or not username:
        return jsonify({"error": "No active authentication challenge found."}), 400
        
    try:
        # Re-pad the base64url challenge and decode it
        challenge_bytes = base64.urlsafe_b64decode(challenge_b64 + '=' * (4 - len(challenge_b64) % 4))
        credential_id = auth_response.get('id')
        
        conn = sqlite3.connect(DATABASE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        # Fetch the passkey from the database using the ID the browser provided
        cursor.execute("SELECT * FROM passkeys WHERE credential_id = ?", (credential_id,))
        passkey = cursor.fetchone()
        
        if not passkey:
            conn.close()
            return jsonify({"error": "Passkey not found in database."}), 404
            
        # Verify the signature from the device
        verification = verify_authentication_response(
            credential=auth_response,
            expected_challenge=challenge_bytes,
            expected_origin=ORIGIN,
            expected_rp_id=RP_ID,
            credential_public_key=passkey['public_key'],
            credential_current_sign_count=passkey['sign_count']
        )
        
        # Update sign_count to prevent cloning attacks
        cursor.execute(
            "UPDATE passkeys SET sign_count = ? WHERE credential_id = ?",
            (verification.new_sign_count, credential_id)
        )
        
        # Log the user in securely
        cursor.execute("SELECT * FROM users WHERE user_id = ?", (passkey['user_id'],))
        user = cursor.fetchone()
        conn.commit()
        conn.close()
        
        if user:
            session.clear()
            session.permanent = True
            session['user_id'] = user['user_id']
            session['username'] = user['username']
            session['role'] = user['role']
            session['session_version'] = user['session_version'] or 1
            
            # Passkeys implicitly act as Two-Step Verification, so we flag them as verified!
            session['is_verified'] = True 
            
            return jsonify({"status": "ok", "redirect": url_for('dashboard')})
        
        return jsonify({"error": "User account not found."}), 404
            
    except Exception as e:
        print(f"Passkey authentication failed: {e}")
        return jsonify({"error": "Authentication failed."}), 400

@app.route('/available-loads')
def available_loads():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Query loads and join with users and reviews to get shipper's rating
    # Only show loads that are not yet matched to a vehicle
    cursor.execute("""
        SELECT
            l.*,
            u.username,
            AVG(r.rating) as avg_rating,
            COUNT(r.rating) as rating_count
        FROM loads l
        JOIN users u ON l.user_id = u.user_id
        LEFT JOIN reviews r ON l.user_id = r.reviewee_id
        -- Hide flagged loads from the public feed (Quarantine)
        WHERE l.payment_status = 'unpaid' AND l.is_flagged = 0 AND l.load_id NOT IN (SELECT load_id FROM matches)
        GROUP BY l.load_id
        ORDER BY l.timestamp DESC
    """)
    loads = cursor.fetchall()
    conn.close()
    return render_template('loads.html', loads=loads)

@app.route('/available-vehicles')
def available_vehicles():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Query vehicles and join with users and reviews to get transporter's rating
    # Only show vehicles that are not yet matched to a load
    cursor.execute("""
        SELECT
            v.*,
            u.username,
            AVG(r.rating) as avg_rating,
            COUNT(r.rating) as rating_count
        FROM vehicles v
        JOIN users u ON v.user_id = u.user_id
        LEFT JOIN reviews r ON v.user_id = r.reviewee_id
        WHERE v.vehicle_id NOT IN (SELECT vehicle_id FROM matches)
        GROUP BY v.vehicle_id
        ORDER BY v.timestamp DESC
    """)
    vehicles = cursor.fetchall()
    conn.close()
    return render_template('trucks.html', trucks=vehicles)

@app.route('/post-load', methods=['POST'])
@verification_required
@limiter.limit("10 per hour") # Fraud Prevention 1: Rate limiting to prevent bot flooding
def receive_load_details():
    if session.get('role') != 'shipper':
        return jsonify({"error": "Only shippers can post loads."}), 403

    description = request.form.get('description')
    weight = request.form.get('weight')
    dimensions = request.form.get('dimensions')
    pickup = request.form.get('pickup')
    delivery = request.form.get('delivery')
    offer = request.form.get('shipper_offer')
    shipping_date = request.form.get('shipping_date')
    ip_address = request.remote_addr

    # Fraud Prevention 2: Sanity bounds checking on the financial offer
    try:
        offer_amount = float(offer)
        if offer_amount < 10 or offer_amount > 50000:
            return jsonify({"error": "Offer must be between $10 and $50,000."}), 400
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid offer amount provided."}), 400

    # Fraud Prevention 3: Redact contact info to prevent off-platform scams
    if description:
        # Redact potential emails
        description = re.sub(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', '[EMAIL REDACTED]', description)
        # Redact potential phone numbers
        description = re.sub(r'\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}', '[PHONE REDACTED]', description)

    # Generate a unique ID for the new load
    load_id = str(uuid.uuid4())
    user_id = session['user_id']

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    # Fetch the user's DOT number, broker status, and ID verification status
    cursor.execute("SELECT dot_number, is_broker_verified, mc_certificate_path, id_verified, is_traveler_verified FROM users WHERE user_id = ?", (user_id,))
    user_row = cursor.fetchone()
    dot_number = user_row[0] if user_row else None
    is_broker_verified = user_row[1] if user_row else 0
    mc_cert_path = user_row[2] if user_row else None
    id_verified = user_row[3] if user_row else 0
    is_traveler_verified = user_row[4] if user_row else 0

    if not id_verified:
        conn.close()
        return jsonify({"error": "Identity verification required. Please connect securely with Stripe in your profile settings."}), 403

    # Fraud Prevention 4: IP Geolocation Validation
    is_flagged = 0
    if pickup and ip_address:
        pickup_lat, pickup_lon = geocode_address(pickup)
        ip_lat, ip_lon = get_ip_location(ip_address)
        
        if pickup_lat is not None and ip_lat is not None:
            distance_miles = calculate_distance(ip_lat, ip_lon, pickup_lat, pickup_lon)
            print(f"Distance between IP location and pickup: {distance_miles:.2f} miles")
            
            # If the user is posting a load more than 1,000 miles away...
            if distance_miles > 1000:
                # ...Check if they are a verified broker first to avoid falsely flagging them!
                if is_broker_verified == 1:
                    print("User is a verified broker. Bypassing geolocation flag.")
                elif dot_number and verify_fmcsa_broker(dot_number):
                    print(f"User DOT {dot_number} verified as active broker. Bypassing flag.")
                    # Cache the verification so we don't have to hit the API every time they post
                    cursor.execute("UPDATE users SET is_broker_verified = 1 WHERE user_id = ?", (user_id,))
                    conn.commit()
                elif is_traveler_verified == 1:
                    print("User is a verified personal traveler. Bypassing geolocation flag.")
                else:
                    if mc_cert_path:
                        is_flagged = 1
                        print(f"Security Alert: Load flagged due to distance ({distance_miles:.0f} miles). User has secondary MC cert.")
                    else:
                        conn.close()
                        return jsonify({"error": "Automated DOT verification failed for long-distance load. Please edit your profile and upload your MC Certificate or Personal ID/Insurance as secondary proof."}), 400

    cursor.execute(
        "INSERT INTO loads (load_id, user_id, description, weight, dimensions, pickup, delivery, offer, shipping_date, timestamp, ip_address, is_flagged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (load_id, user_id, description, weight, dimensions, pickup, delivery, offer, shipping_date, time.time(), ip_address, is_flagged)
    )
    conn.commit()
    conn.close()

    # Fraud Prevention 5: Automatically notify admin of flagged loads
    if is_flagged == 1:
        # We default to sending it to your primary email, but you can set ADMIN_EMAIL in your .env
        admin_email = os.environ.get("ADMIN_EMAIL", "gottabackhaul@gmail.com")
        text_content = (
            f"Security Alert: A newly posted load has been flagged for suspicious geolocation activity.\n\n"
            f"User: {session.get('username')}\n"
            f"Pickup Location: {pickup}\n"
            f"User IP Address: {ip_address}\n"
            f"IP Reputation Check: https://www.abuseipdb.com/check/{ip_address}\n"
            f"Load ID: {load_id}\n\n"
            f"The user's IP location is > 1,000 miles away from the pickup location.\n"
            f"This load has been QUARANTINED and is hidden from the public feed.\n"
            f"Please verify its legitimacy before approving it on the Admin Dashboard."
        )
        send_email(admin_email, "Action Required: Suspicious Load Flagged", text_content)

    print(f'Received and saved load {load_id}: {description}, weight: {weight}, offer: {offer}')
    # Redirect to dashboard to see the new listing
    return redirect(url_for('dashboard'))

@app.route('/post-vehicle', methods=['POST'])
@verification_required
def receive_vehicle_details():
    if session.get('role') != 'transporter':
        return jsonify({"error": "Only transporters can post vehicles."}), 403

    """
    Allows any driver (truckers, personal vehicle owners, couriers) to post their availability.
    """
    # This can now be anything: 'Semi-Truck', 'Cargo Van', 'Sedan', 'SUV', etc.
    vehicle_type = request.form.get('vehicle_type') 
    departure_city = request.form.get('departure_city')
    destination_city = request.form.get('destination_city')
    start_date = request.form.get('start_date')
    end_date = request.form.get('end_date')
    max_weight = request.form.get('max_weight')
    max_dimensions = request.form.get('max_dimensions')
    
    # Generate a unique ID for the driver's vehicle posting
    vehicle_id = str(uuid.uuid4())
    user_id = session['user_id']

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    # Verify identity first
    cursor.execute("SELECT id_verified FROM users WHERE user_id = ?", (user_id,))
    user_row = cursor.fetchone()
    if not user_row or not user_row[0]:
        conn.close()
        return jsonify({"error": "Identity verification required. Please connect securely with Stripe in your profile settings."}), 403

    cursor.execute(
        "INSERT INTO vehicles (vehicle_id, user_id, vehicle_type, departure_city, destination_city, start_date, end_date, max_weight, max_dimensions, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (vehicle_id, user_id, vehicle_type, departure_city, destination_city, start_date, end_date, max_weight, max_dimensions, time.time())
    )
    conn.commit()
    conn.close()

    print(f'Received vehicle {vehicle_id}: {vehicle_type} (Max weight: {max_weight}, Max dims: {max_dimensions}), route: {departure_city} to {destination_city}')
    # Redirect to dashboard to see the new listing
    return redirect(url_for('dashboard'))

@app.route('/match-load', methods=['POST'])
@verification_required
def match_load():
    """
    Assigns a specific load to a specific vehicle/driver.
    """
    load_id = request.form.get('load_id')
    vehicle_id = request.form.get('vehicle_id')

    if not load_id or not vehicle_id:
        return jsonify({"error": "Both 'load_id' and 'vehicle_id' are required."}), 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    # Verify identity first
    user_id = session.get('user_id')
    cursor.execute("SELECT id_verified FROM users WHERE user_id = ?", (user_id,))
    user_row = cursor.fetchone()
    if not user_row or not user_row[0]:
        conn.close()
        return jsonify({"error": "Identity verification required. Please connect securely with Stripe in your profile settings."}), 403

    # Verify both the load and the vehicle exist before matching
    cursor.execute("SELECT load_id FROM loads WHERE load_id = ?", (load_id,))
    if not cursor.fetchone():
        return jsonify({"error": f"Load ID '{load_id}' not found."}), 404
        
    cursor.execute("SELECT vehicle_id FROM vehicles WHERE vehicle_id = ?", (vehicle_id,))
    if not cursor.fetchone():
        return jsonify({"error": f"Vehicle ID '{vehicle_id}' not found."}), 404

    match_id = str(uuid.uuid4())
    cursor.execute(
        "INSERT INTO matches (match_id, load_id, vehicle_id, timestamp) VALUES (?, ?, ?, ?)",
        (match_id, load_id, vehicle_id, time.time())
    )
    conn.commit()
    conn.close()

    print(f"Successfully matched load {load_id} to vehicle {vehicle_id} (Match ID: {match_id})")
    return jsonify({"message": "Load successfully matched to vehicle!", "match_id": match_id}), 201

def release_escrow_funds(load_id, cursor):
    """Releases funds to the transporter when delivery is confirmed."""
    cursor.execute("""
        SELECT l.offer, l.payment_status, u.stripe_account_id
        FROM loads l
        JOIN matches m ON l.load_id = m.load_id
        JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        JOIN users u ON v.user_id = u.user_id
        WHERE l.load_id = ? AND l.payment_status = 'paid'
    """, (load_id,))
    load_data = cursor.fetchone()
    
    if load_data and load_data[2]: # Ensure they have a connected Stripe Account
        offer_amount_cents = int(float(load_data[0]) * 100)
        platform_fee_cents = int(offer_amount_cents * 0.10) # E.g., App keeps a 10% cut
        payout_amount_cents = offer_amount_cents - platform_fee_cents
        
        try:
            stripe.Transfer.create(
                amount=payout_amount_cents,
                currency="usd",
                destination=load_data[2],
                description=f"Delivery payout for load {load_id}"
            )
            print(f"Escrow released: {payout_amount_cents} cents transferred to {load_data[2]}")
        except stripe.error.StripeError as e:
            print(f"Stripe Transfer Error for load {load_id}: {e}")

def notify_shipper_delivery(load_id):
    """Sends an email to the shipper notifying them that delivery proof has been uploaded."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT u.email, l.description 
        FROM loads l
        JOIN users u ON l.user_id = u.user_id
        WHERE l.load_id = ?
    """, (load_id,))
    
    row = cursor.fetchone()
    conn.close()
    
    if row and row['email']:
        proof_link = url_for('view_delivery_proof', load_id=load_id, _external=True)
        text_content = f"Hello,\n\nThe transporter has uploaded delivery proof for your load: '{row['description']}'.\n\nYou can view the photo and verify the GPS location by clicking the link below:\n{proof_link}\n\nThank you for using GottaBackhaul!"
        send_email(row['email'], f"Delivery Proof Uploaded: {row['description']}", text_content)

def notify_dispute_created(load_id):
    """Sends an email to the shipper and transporter notifying them of a payment dispute."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get Shipper email and Load description
    cursor.execute("""
        SELECT u.email, l.description 
        FROM loads l
        JOIN users u ON l.user_id = u.user_id
        WHERE l.load_id = ?
    """, (load_id,))
    shipper_row = cursor.fetchone()
    
    # Get Transporter email
    cursor.execute("""
        SELECT u.email
        FROM matches m
        JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        JOIN users u ON v.user_id = u.user_id
        WHERE m.load_id = ?
    """, (load_id,))
    transporter_row = cursor.fetchone()
    
    conn.close()
    
    emails_to_notify = []
    if shipper_row and shipper_row['email']:
        emails_to_notify.append(shipper_row['email'])
    if transporter_row and transporter_row['email']:
        emails_to_notify.append(transporter_row['email'])
        
    if emails_to_notify and shipper_row:
        text_content = f"Hello,\n\nA payment dispute has been opened for the load: '{shipper_row['description']}'.\n\nPlease check your dashboard and contact support to provide any necessary evidence or context.\n\nThank you for using GottaBackhaul."
        send_email(", ".join(emails_to_notify), f"Action Required: Dispute Opened for '{shipper_row['description']}'", text_content)

def notify_dispute_resolved(load_id, status):
    """Sends an email to the transporter notifying them of the dispute outcome."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get Transporter email and Load description
    cursor.execute("""
        SELECT u.email, l.description 
        FROM matches m
        JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        JOIN users u ON v.user_id = u.user_id
        JOIN loads l ON m.load_id = l.load_id
        WHERE m.load_id = ?
    """, (load_id,))
    row = cursor.fetchone()
    conn.close()
    
    if row and row['email']:
        if status == 'won':
            text_content = f"Hello,\n\nWe have successfully won the payment dispute for the load: '{row['description']}'.\n\nThe funds will remain in your account and no further action is required from you.\n\nThank you for using GottaBackhaul."
            subject = f"Good News: Dispute Won for '{row['description']}'"
        else:
            text_content = f"Hello,\n\nUnfortunately, the bank has ruled in favor of the cardholder for the dispute on the load: '{row['description']}'.\n\nThe funds for this load will be reversed from your account. If you have questions, please contact support.\n\nThank you for using GottaBackhaul."
            subject = f"Update: Dispute Lost for '{row['description']}'"
        send_email(row['email'], subject, text_content)

@app.route('/delivery-confirmation', methods=['POST'])
def delivery_confirmation():
    """
    Handles delivery confirmation via a text signature or an uploaded image.
    Expects a 'load_id' in the form data to identify the delivery.
    For signatures, expects a 'signature' field.
    For pictures, expects a file in the 'delivery_proof_pic' field.
    """
    load_id = request.form.get('load_id')
    if not load_id:
        return jsonify({"error": "Missing 'load_id' in form data."}), 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    # --- Option 1: Handle text signature ---
    signature = request.form.get('signature')
    if signature:
        cursor.execute(
            "INSERT INTO delivery_proofs (load_id, signature, timestamp) VALUES (?, ?, ?)",
            (load_id, signature, time.time())
        )
        conn.commit()
        release_escrow_funds(load_id, cursor)
        conn.close()
        notify_shipper_delivery(load_id)
        print(f"Received signature for load '{load_id}': {signature}")
        return f"Signature received for load {load_id}!"

    # --- Option 2: Handle image upload ---
    if 'delivery_proof_pic' not in request.files:
        return 'No file part in the request. Please use the "delivery_proof_pic" field.', 400
    
    file = request.files['delivery_proof_pic']

    if file.filename == '':
        return 'No file selected for upload.', 400
        
    lat_str = request.form.get('latitude')
    lon_str = request.form.get('longitude')
    
    if not lat_str or not lon_str:
        conn.close()
        return jsonify({"error": "GPS coordinates (latitude and longitude) are required for photo uploads to verify location."}), 400
        
    try:
        photo_lat = float(lat_str)
        photo_lon = float(lon_str)
    except ValueError:
        conn.close()
        return jsonify({"error": "Invalid GPS coordinates provided."}), 400

    # Geofencing Check: Verify the photo coordinates match the load's delivery address
    cursor.execute("SELECT delivery FROM loads WHERE load_id = ?", (load_id,))
    load_row = cursor.fetchone()
    if not load_row:
        conn.close()
        return jsonify({"error": "Load not found."}), 404
        
    delivery_address = load_row[0]
    expected_lat, expected_lon = geocode_address(delivery_address)
    
    if expected_lat is not None and expected_lon is not None:
        distance_miles = calculate_distance(photo_lat, photo_lon, expected_lat, expected_lon)
        
        # If the photo was taken more than 1 mile away from the delivery destination, reject it
        if distance_miles > 1.0:
            conn.close()
            return jsonify({"error": f"Delivery photo rejected: Location is {distance_miles:.2f} miles away from the target delivery destination."}), 400
    else:
        print(f"Warning: Could not geocode delivery address '{delivery_address}' for load {load_id}. Skipping strict geofence validation.")

    if file:
        filename = secure_filename(file.filename)
        os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
        unique_filename = f"{load_id}_{filename}"
        save_path = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
        
        file.save(save_path)

        cursor.execute(
            "INSERT INTO delivery_proofs (load_id, image_path, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?)",
            (load_id, save_path, photo_lat, photo_lon, time.time())
        )
        conn.commit()
        release_escrow_funds(load_id, cursor)
        conn.close()
        notify_shipper_delivery(load_id)
        print(f"Delivery proof for load '{load_id}' saved to {save_path}")
        return f"File '{filename}' for load {load_id} uploaded successfully!"

    conn.close() # Close connection if no action was taken
    return 'An unknown error occurred while uploading.', 500

@app.route('/submit_pod/<match_id>', methods=['GET', 'POST'])
@login_required
def submit_pod(match_id):
    """
    Allows the transporter to submit Proof of Delivery (POD) for a matched load.
    """
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Verify the match exists and the user is the assigned transporter
    cursor.execute("""
        SELECT m.load_id, v.user_id as transporter_id 
        FROM matches m
        JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        WHERE m.match_id = ?
    """, (match_id,))
    match_info = cursor.fetchone()

    if not match_info:
        conn.close()
        return "Match not found", 404

    if match_info['transporter_id'] != session['user_id']:
        conn.close()
        return "Unauthorized: Only the transporter can submit the POD.", 403
        
    load_id = match_info['load_id']

    if request.method == 'POST':
        signature = request.form.get('signature')
        file = request.files.get('delivery_proof_pic')
        
        if signature:
            cursor.execute(
                "INSERT INTO delivery_proofs (load_id, signature, timestamp) VALUES (?, ?, ?)",
                (load_id, signature, time.time())
            )
        elif file and file.filename != '':
            lat_str = request.form.get('latitude')
            lon_str = request.form.get('longitude')
            
            if not lat_str or not lon_str:
                conn.close()
                return "GPS coordinates are required to submit a photo.", 400
                
            try:
                photo_lat = float(lat_str)
                photo_lon = float(lon_str)
            except ValueError:
                conn.close()
                return "Invalid GPS coordinates.", 400
                
            # Geofencing Check: Verify the photo coordinates match the load's delivery address
            cursor.execute("SELECT delivery FROM loads WHERE load_id = ?", (load_id,))
            load_row = cursor.fetchone()
            if load_row:
                expected_lat, expected_lon = geocode_address(load_row[0])
                if expected_lat is not None and expected_lon is not None:
                    distance_miles = calculate_distance(photo_lat, photo_lon, expected_lat, expected_lon)
                    # If the photo was taken more than 1 mile away from the delivery destination, reject it
                    if distance_miles > 1.0:
                        conn.close()
                        return f"Delivery photo rejected: Location is {distance_miles:.2f} miles away from the target delivery destination.", 400

            filename = secure_filename(file.filename)
            os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
            unique_filename = f"{load_id}_{filename}"
            save_path = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
            file.save(save_path)

            cursor.execute(
                "INSERT INTO delivery_proofs (load_id, image_path, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?)",
                (load_id, save_path, photo_lat, photo_lon, time.time())
            )
        else:
            conn.close()
            return "No signature or file provided.", 400

        conn.commit()
        release_escrow_funds(load_id, cursor)
        conn.close()
        notify_shipper_delivery(load_id)
        return redirect(url_for('dashboard'))

    conn.close()
    return render_template('submit_pod.html', match_id=match_id, load_id=load_id)

@app.route('/update-location', methods=['POST'])
def update_location():
    """
    Receives GPS coordinates from a trucker's device and updates the load's location.
    """
    load_id = request.form.get('load_id')
    latitude = request.form.get('latitude')
    longitude = request.form.get('longitude')
    
    if not load_id or not latitude or not longitude:
        return jsonify({"error": "Missing load_id, latitude, or longitude"}), 400
        
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    # Use INSERT OR REPLACE to create a new location entry or update the existing one.
    cursor.execute(
        "INSERT OR REPLACE INTO locations (load_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?)",
        (load_id, latitude, longitude, time.time())
    )
    conn.commit()
    conn.close()
    
    print(f"Location updated for load {load_id}: {latitude}, {longitude}")
    return jsonify({"status": "Location updated successfully!", "load_id": load_id}), 200

@app.route('/track-load/<load_id>', methods=['GET'])
def track_load(load_id):
    """
    Allows a shipper to retrieve the latest known location of a specific load.
    """
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row # This allows accessing columns by name
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM locations WHERE load_id = ?", (load_id,))
    location_row = cursor.fetchone()
    conn.close()

    if location_row:
        # Convert the sqlite3.Row object to a dictionary before returning as JSON
        return jsonify(dict(location_row)), 200
    else:
        return jsonify({"error": "Load ID not found or no location data available."}), 404

@app.route('/view-delivery-proof/<load_id>')
@login_required
def view_delivery_proof(load_id):
    """Displays the delivery photo and a map of where it was taken."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Ensure the user is authorized to view this load's delivery proof
    cursor.execute("""
        SELECT l.user_id as shipper_id, v.user_id as transporter_id
        FROM loads l
        LEFT JOIN matches m ON l.load_id = m.load_id
        LEFT JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        WHERE l.load_id = ?
    """, (load_id,))
    load_users = cursor.fetchone()
    
    if not load_users or session['user_id'] not in [load_users['shipper_id'], load_users['transporter_id']]:
        conn.close()
        return "Unauthorized access.", 403

    cursor.execute("SELECT * FROM delivery_proofs WHERE load_id = ?", (load_id,))
    proof = cursor.fetchone()
    
    cursor.execute("SELECT payment_status FROM loads WHERE load_id = ?", (load_id,))
    load_status = cursor.fetchone()
    conn.close()
    
    if not proof:
        return "Delivery proof not found.", 404
        
    return render_template('view_delivery_proof.html', proof=proof, load_users=load_users, load_id=load_id, load_status=load_status)

@app.route('/dispute-delivery/<load_id>', methods=['POST'])
@login_required
def dispute_delivery(load_id):
    """Allows a shipper to dispute a delivery if the proof is incorrect."""
    user_id = session['user_id']
    reason = request.form.get('reason')
    
    if not reason:
        return "Dispute reason is required.", 400
        
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    # Verify user is the shipper
    cursor.execute("SELECT user_id FROM loads WHERE load_id = ?", (load_id,))
    load_row = cursor.fetchone()
    
    if not load_row or load_row[0] != user_id:
        conn.close()
        return "Unauthorized: Only the shipper can dispute this delivery.", 403
        
    # Mark the load as disputed
    cursor.execute("UPDATE loads SET payment_status = 'disputed' WHERE load_id = ?", (load_id,))
    
    # Save the dispute reason as evidence
    cursor.execute("INSERT INTO dispute_evidence (load_id, user_id, comments, timestamp) VALUES (?, ?, ?, ?)",
                   (load_id, user_id, f"Shipper disputed delivery proof: {reason}", time.time()))
                   
    conn.commit()
    conn.close()
    
    notify_dispute_created(load_id)
    
    return redirect(url_for('dashboard'))

@app.route('/delivery_proofs/<path:filename>')
@login_required
def serve_delivery_proof(filename):
    """Serves the securely uploaded delivery proof images."""
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# --- Payment Routes ---
@app.route('/create-checkout-session/<load_id>', methods=['POST'])
@verification_required
def create_checkout_session(load_id):
    """
    Creates a Stripe Checkout session for a specific load.
    """
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM loads WHERE load_id = ?", (load_id,))
    load = cursor.fetchone()
    conn.close()

    if not load:
        return "Load not found", 404

    # Ensure the current user is the one who posted the load
    if load['user_id'] != session['user_id']:
        return "Unauthorized", 403

    try:
        # The 'offer' is stored as a string, e.g., "500". Convert to cents.
        # This parsing is basic; a more robust solution would handle currency symbols, etc.
        offer_amount = int(float(load['offer']) * 100)  # e.g., 500.00 -> 50000
        
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=['card'],
            line_items=[{
                'price_data': {
                    'currency': 'usd',
                    'product_data': {
                        'name': f"Payment for: {load['description']}",
                    },
                    'unit_amount': offer_amount,
                },
                'quantity': 1,
            }],
            mode='payment',
            # Pass the load_id to the success URL to update its status
            success_url=url_for('payment_success', load_id=load_id, _external=True),
            cancel_url=url_for('payment_cancel', _external=True),
            # Store load_id in metadata to retrieve it in webhooks if needed
            payment_intent_data={
                'metadata': {
                    'load_id': load_id
                }
            },
            metadata={
                'load_id': load_id
            }
        )
        return redirect(checkout_session.url, code=303)
    except Exception as e:
        print(f"Error creating Stripe session: {e}")
        return "Error creating payment session.", 500

@app.route('/payment-success')
def payment_success():
    """
    Handles successful payments. Updates the load's payment status in the database.
    """
    load_id = request.args.get('load_id')
    if load_id:
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("UPDATE loads SET payment_status = 'paid' WHERE load_id = ?", (load_id,))
        conn.commit()
        conn.close()
        print(f"Load {load_id} marked as paid.")
    return f'<h1>Payment Successful!</h1><p>Your payment for load {load_id or ""} was processed.</p><a href="{url_for("dashboard")}">Go to Dashboard</a>'

@app.route('/payment-cancel')
def payment_cancel():
    return f'<h1>Payment Canceled</h1><p>Your payment was not processed. You can try again from the dashboard.</p><a href="{url_for("dashboard")}">Go to Dashboard</a>'

@app.route('/stripe-webhook', methods=['POST'])
def stripe_webhook():
    """Endpoint for Stripe to send asynchronous event notifications."""
    payload = request.data
    sig_header = request.headers.get('Stripe-Signature')
    endpoint_secret = os.environ.get('STRIPE_WEBHOOK_SECRET')

    if not endpoint_secret:
        print("⚠️  Stripe webhook secret not configured in .env.")
        return jsonify({'error': 'Webhook secret not configured'}), 500

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, endpoint_secret
        )
    except ValueError as e:
        # Invalid payload
        return "Invalid payload", 400
    except stripe.error.SignatureVerificationError as e:
        # Invalid signature
        return "Invalid signature", 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    # Handle refund event
    if event['type'] == 'charge.refunded':
        charge = event['data']['object']
        load_id = charge.get('metadata', {}).get('load_id')
        if load_id:
            cursor.execute("UPDATE loads SET payment_status = 'refunded' WHERE load_id = ?", (load_id,))
            print(f"💸 Load {load_id} payment status updated to 'refunded'.")

    # Handle dispute event
    elif event['type'] == 'charge.dispute.created':
        dispute = event['data']['object']
        try:
            # Retrieve the associated charge to access our custom load_id metadata
            charge = stripe.Charge.retrieve(dispute['charge'])
            load_id = charge.get('metadata', {}).get('load_id')
            if load_id:
                cursor.execute("UPDATE loads SET payment_status = 'disputed', stripe_dispute_id = ? WHERE load_id = ?", (dispute['id'], load_id))
                print(f"🚨 Load {load_id} payment status updated to 'disputed'.")
                notify_dispute_created(load_id)
        except Exception as e:
            print(f"Error retrieving charge for dispute: {e}")

    # Handle closed dispute
    elif event['type'] == 'charge.dispute.closed':
        dispute = event['data']['object']
        try:
            charge = stripe.Charge.retrieve(dispute['charge'])
            load_id = charge.get('metadata', {}).get('load_id')
            if load_id:
                if dispute['status'] == 'won':
                    cursor.execute("UPDATE loads SET payment_status = 'dispute_won' WHERE load_id = ?", (load_id,))
                    print(f"🏆 Load {load_id} payment status updated to 'dispute_won'.")
                elif dispute['status'] == 'lost':
                    cursor.execute("UPDATE loads SET payment_status = 'dispute_lost' WHERE load_id = ?", (load_id,))
                    print(f"💸 Load {load_id} payment status updated to 'dispute_lost'.")
                notify_dispute_resolved(load_id, dispute['status'])
        except Exception as e:
            print(f"Error retrieving charge for closed dispute: {e}")

    # Handle Stripe Connect account updates (e.g., identity verification completed)
    elif event['type'] == 'account.updated':
        account = event['data']['object']
        if account.get('details_submitted'):
            stripe_account_id = account.get('id')
            if stripe_account_id:
                cursor.execute("UPDATE users SET id_verified = 1 WHERE stripe_account_id = ?", (stripe_account_id,))
                print(f"✅ User with Stripe Account {stripe_account_id} marked as ID verified via webhook.")

    conn.commit()
    conn.close()
    return jsonify({'status': 'success'}), 200

@app.route('/submit-evidence/<load_id>', methods=['POST'])
@login_required
def submit_evidence(load_id):
    """Allows users to submit text and files as evidence for a dispute."""
    user_id = session['user_id']
    comments = request.form.get('comments')
    file = request.files.get('evidence_file')
    
    # Extract the new fields sent from the frontend
    service_date = request.form.get('service_date')
    shipping_tracking_number = request.form.get('shipping_tracking_number')

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    # 1. Fetch Dispute ID and Shipper's Email from the DB
    cursor.execute("""
        SELECT l.stripe_dispute_id, u.email, l.ip_address
        FROM loads l
        JOIN users u ON l.user_id = u.user_id
        WHERE l.load_id = ?
    """, (load_id,))
    load_row = cursor.fetchone()
    dispute_id = load_row[0] if load_row else None
    customer_email = load_row[1] if load_row else None
    customer_ip = load_row[2] if load_row else None
    
    cursor.execute("SELECT image_path FROM delivery_proofs WHERE load_id = ?", (load_id,))
    proof_row = cursor.fetchone()
    delivery_proof_path = proof_row[0] if proof_row else None

    save_path = None
    if file and file.filename != '':
        filename = secure_filename(file.filename)
        evidence_dir = os.path.join(app.config['UPLOAD_FOLDER'], 'evidence')
        os.makedirs(evidence_dir, exist_ok=True)
        unique_filename = f"evidence_{load_id}_{uuid.uuid4().hex[:8]}_{filename}"
        save_path = os.path.join(evidence_dir, unique_filename)
        file.save(save_path)
        
    # 2. Push Evidence directly to the Bank via Stripe API
    if dispute_id:
        evidence_payload = {}
        if comments:
            evidence_payload['uncategorized_text'] = comments
        if customer_email:
            evidence_payload['customer_email_address'] = customer_email
        if customer_ip:
            evidence_payload['customer_purchase_ip'] = customer_ip
        if service_date:
            evidence_payload['service_date'] = service_date
        if shipping_tracking_number:
            evidence_payload['shipping_tracking_number'] = shipping_tracking_number
            
        # Upload the Transporter's new contextual evidence file
        if save_path:
            try:
                with open(save_path, 'rb') as f:
                    stripe_evidence_file = stripe.File.create(purpose='dispute_evidence', file=f)
                    evidence_payload['uncategorized_file'] = stripe_evidence_file.id
            except Exception as e:
                print(f"Stripe evidence file upload failed: {e}")
        
        # Automatically upload and attach the original GPS Delivery Photo to win the case
        if delivery_proof_path and os.path.exists(delivery_proof_path):
            try:
                with open(delivery_proof_path, 'rb') as f:
                    stripe_proof_file = stripe.File.create(purpose='dispute_evidence', file=f)
                    evidence_payload['shipping_documentation'] = stripe_proof_file.id
            except Exception as e:
                print(f"Stripe delivery proof upload failed: {e}")

        # Modify the dispute object so Stripe packages it to the issuer
        if evidence_payload:
            print("\n--- Outgoing Stripe Evidence Payload ---")
            print(evidence_payload)
            try:
                stripe.Dispute.modify(dispute_id, evidence=evidence_payload)
                print(f"Evidence successfully pushed to Stripe for dispute {dispute_id}")
            except Exception as e:
                print(f"Stripe dispute update failed: {e}")
                
    # 3. Save locally and update state
    cursor.execute("INSERT INTO dispute_evidence (load_id, user_id, comments, file_path, timestamp) VALUES (?, ?, ?, ?, ?)",
                   (load_id, user_id, comments, save_path, time.time()))
    cursor.execute("UPDATE loads SET payment_status = 'dispute_under_review' WHERE load_id = ?", (load_id,))
    conn.commit()
    conn.close()
    
    return redirect(url_for('dashboard'))

@app.route('/dashboard')
@login_required
def dashboard():
    user_id = session['user_id']
    role = session['role']
    
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Fetch the current user details to pass to the template
    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    
    # --- Check for Expired Insurance ---
    insurance_expired = False
    if user and user['insurance_expiration_date']:
        try:
            exp_date = datetime.datetime.strptime(user['insurance_expiration_date'], '%Y-%m-%d').date()
            if datetime.date.today() > exp_date:
                insurance_expired = True
                if user['is_traveler_verified'] == 1:
                    cursor.execute("UPDATE users SET is_traveler_verified = 0 WHERE user_id = ?", (user_id,))
                    conn.commit()
                    # Re-fetch user so the dashboard reflects the revoked status immediately
                    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
                    user = cursor.fetchone()
        except ValueError:
            pass

    # Fetch user ratings for the dashboard header
    cursor.execute("SELECT AVG(rating) as avg_rating, COUNT(rating) as rating_count FROM reviews WHERE reviewee_id = ?", (user_id,))
    rating_stats = cursor.fetchone()
    
    my_listings = []
    completed_jobs = []

    if role == 'shipper':
        # Get the shipper's own load postings
        cursor.execute("SELECT * FROM loads WHERE user_id = ? ORDER BY timestamp DESC", (user_id,))
        my_listings = cursor.fetchall()

        # Get completed loads (paid for) to allow for reviews
        cursor.execute("""
            SELECT 
                l.*, m.match_id, v.user_id as transporter_id, r.review_id
            FROM loads l
            JOIN matches m ON l.load_id = m.load_id
            JOIN vehicles v ON m.vehicle_id = v.vehicle_id
            LEFT JOIN reviews r ON m.match_id = r.match_id AND r.reviewer_id = ?
            WHERE l.user_id = ? AND l.payment_status IN ('paid', 'disputed', 'dispute_under_review', 'dispute_won', 'dispute_lost')
        """, (user_id, user_id))
        completed_jobs = cursor.fetchall()

    elif role == 'transporter':
        # Get the transporter's own vehicle postings
        cursor.execute("SELECT * FROM vehicles WHERE user_id = ? ORDER BY timestamp DESC", (user_id,))
        my_listings = cursor.fetchall()

        # Get completed loads they transported to allow for reviews
        cursor.execute("""
            SELECT 
                l.*, m.match_id, l.user_id as shipper_id, r.review_id
            FROM vehicles v
            JOIN matches m ON v.vehicle_id = m.vehicle_id
            JOIN loads l ON m.load_id = l.load_id
            LEFT JOIN reviews r ON m.match_id = r.match_id AND r.reviewer_id = ?
            WHERE v.user_id = ? AND l.payment_status IN ('paid', 'disputed', 'dispute_under_review', 'dispute_won', 'dispute_lost')
        """, (user_id, user_id))
        completed_jobs = cursor.fetchall()
        
    # Fetch the user's registered passkeys
    cursor.execute("SELECT credential_id, sign_count FROM passkeys WHERE user_id = ?", (user_id,))
    passkeys = cursor.fetchall()
    
    # Fetch the user's matches
    cursor.execute("""
        SELECT m.*, l.description as load_description, l.user_id as shipper_id,
               v.user_id as driver_id, v.vehicle_type, u_driver.username as driver_username, u_shipper.username as shipper_username
        FROM matches m
        JOIN loads l ON m.load_id = l.load_id
        JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        JOIN users u_driver ON v.user_id = u_driver.user_id
        JOIN users u_shipper ON l.user_id = u_shipper.user_id
        WHERE l.user_id = ? OR v.user_id = ?
        ORDER BY m.timestamp DESC
    """, (user_id, user_id))
    raw_matches = cursor.fetchall()
    
    matches = []
    for rm in raw_matches:
        match_dict = dict(rm)
        match_dict['is_shipper'] = (match_dict['shipper_id'] == user_id)
        match_dict['other_user_username'] = match_dict['driver_username'] if match_dict['is_shipper'] else match_dict['shipper_username']
        match_dict['other_user_id'] = match_dict['driver_id'] if match_dict['is_shipper'] else match_dict['shipper_id']
        match_dict['match_date'] = match_dict['timestamp']
        
        cursor.execute("SELECT 1 FROM reviews WHERE match_id = ? AND reviewer_id = ?", (match_dict['match_id'], user_id))
        match_dict['review_left'] = bool(cursor.fetchone())
        matches.append(match_dict)

    conn.close()
    
    return render_template('dashboard.html', 
                           user=user,
                           loads=my_listings if role == 'shipper' else [],
                           trucks=my_listings if role == 'transporter' else [],
                           completed_jobs=completed_jobs, 
                           role=role,
                           rating_stats=rating_stats,
                           matches=matches,
                           passkeys=passkeys,
                           insurance_expired=insurance_expired)

@app.route('/delete-passkey/<credential_id>', methods=['POST'])
@login_required
def delete_passkey(credential_id):
    """Allows a user to delete one of their registered passkeys."""
    user_id = session['user_id']
    
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    # Delete the passkey, ensuring it belongs to the logged-in user
    cursor.execute("DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?", (credential_id, user_id))
    conn.commit()
    conn.close()
    
    return redirect(url_for('dashboard'))

@app.route('/delete-account', methods=['POST'])
@login_required
def delete_account():
    """
    Handles user account deletion in compliance with GDPR's Right to Erasure.
    This is a destructive action and will permanently remove the user's data
    and any content they have created.
    """
    user_id = session['user_id']
    
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row # To access columns by name
    cursor = conn.cursor()

    try:
        # --- Step 1: Gather all associated file paths before deletion ---
        files_to_delete = []
        
        # Get user's uploaded document paths from their profile
        cursor.execute("SELECT mc_certificate_path, insurance_path, drivers_license_path FROM users WHERE user_id = ?", (user_id,))
        user_docs = cursor.fetchone()
        if user_docs:
            files_to_delete.extend([path for path in user_docs if path])

        # Get paths for delivery proof and evidence files
        cursor.execute("""
            SELECT dp.image_path FROM delivery_proofs dp
            JOIN loads l ON dp.load_id = l.load_id
            WHERE l.user_id = ? AND dp.image_path IS NOT NULL
        """, (user_id,))
        files_to_delete.extend([row['image_path'] for row in cursor.fetchall()])

        cursor.execute("SELECT file_path FROM dispute_evidence WHERE user_id = ? AND file_path IS NOT NULL", (user_id,))
        files_to_delete.extend([row['file_path'] for row in cursor.fetchall()])

        # --- Step 2: Delete database records in a single transaction ---
        with conn:
            # Get IDs of loads created by the user
            cursor.execute("SELECT load_id FROM loads WHERE user_id = ?", (user_id,))
            load_ids = [row['load_id'] for row in cursor.fetchall()]
            
            # Delete records that directly reference the user
            cursor.execute("DELETE FROM passkeys WHERE user_id = ?", (user_id,))
            cursor.execute("DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?", (user_id, user_id))
            cursor.execute("DELETE FROM reviews WHERE reviewer_id = ? OR reviewee_id = ?", (user_id, user_id))
            cursor.execute("DELETE FROM dispute_evidence WHERE user_id = ?", (user_id,))
            
            # Delete loads and their dependent data
            if load_ids:
                placeholders = ','.join('?' for _ in load_ids)
                cursor.execute(f"DELETE FROM locations WHERE load_id IN ({placeholders})", load_ids)
                cursor.execute(f"DELETE FROM delivery_proofs WHERE load_id IN ({placeholders})", load_ids)
                cursor.execute(f"DELETE FROM matches WHERE load_id IN ({placeholders})", load_ids)
            cursor.execute("DELETE FROM loads WHERE user_id = ?", (user_id,))
            
            # Delete vehicles and any remaining matches associated with them
            cursor.execute("DELETE FROM matches WHERE vehicle_id IN (SELECT vehicle_id FROM vehicles WHERE user_id = ?)", (user_id,))
            cursor.execute("DELETE FROM vehicles WHERE user_id = ?", (user_id,))
            
            # Finally, delete the user record
            cursor.execute("DELETE FROM users WHERE user_id = ?", (user_id,))

        # --- Step 3: Delete physical files from the server ---
        for file_path in set(files_to_delete): # Use set to avoid deleting the same file twice
            if file_path and os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except OSError as e:
                    print(f"Error deleting file {file_path}: {e}")

    except sqlite3.Error as e:
        print(f"Database error during account deletion for user {user_id}: {e}")
        return "An error occurred during account deletion. Please contact support.", 500
    finally:
        conn.close()

    session.clear()
    return redirect(url_for('index'))

@app.route('/export-my-data', methods=['GET'])
@login_required
def export_my_data():
    """
    Handles user data export in compliance with GDPR's Right of Access.
    Compiles all user-related data into a single JSON file for download.
    """
    user_id = session['user_id']
    
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    data_export = {}

    try:
        # 1. Profile Data (excluding password hash)
        cursor.execute("""
            SELECT user_id, username, email, role, session_version, dot_number, 
                   is_broker_verified, bio, contact_info, mc_certificate_path, 
                   insurance_path, drivers_license_path, is_traveler_verified, 
                   insurance_expiration_date, stripe_account_id, id_verified, 
                   privacy_policy_agreed, agreed_to_policy_version, agreement_timestamp 
            FROM users WHERE user_id = ?
        """, (user_id,))
        profile = cursor.fetchone()
        data_export['profile'] = dict(profile) if profile else {}

        # 2. Loads Posted by User
        cursor.execute("SELECT * FROM loads WHERE user_id = ?", (user_id,))
        loads_posted = [dict(row) for row in cursor.fetchall()]
        data_export['loads_posted'] = loads_posted
        load_ids = [load['load_id'] for load in loads_posted]

        # 3. Vehicles Registered by User
        cursor.execute("SELECT * FROM vehicles WHERE user_id = ?", (user_id,))
        data_export['vehicles_registered'] = [dict(row) for row in cursor.fetchall()]

        # 4. Messages Sent or Received
        cursor.execute("SELECT * FROM messages WHERE sender_id = ? OR receiver_id = ?", (user_id, user_id))
        data_export['messages'] = [dict(row) for row in cursor.fetchall()]

        # 5. Reviews Given or Received
        cursor.execute("SELECT * FROM reviews WHERE reviewer_id = ? OR reviewee_id = ?", (user_id, user_id))
        data_export['reviews'] = [dict(row) for row in cursor.fetchall()]

        # 6. Passkeys (excluding public key blob for security/size)
        cursor.execute("SELECT credential_id, sign_count, transports FROM passkeys WHERE user_id = ?", (user_id,))
        data_export['passkeys'] = [dict(row) for row in cursor.fetchall()]

        # 7. Dispute Evidence submitted by the user
        cursor.execute("SELECT * FROM dispute_evidence WHERE user_id = ?", (user_id,))
        data_export['dispute_evidence'] = [dict(row) for row in cursor.fetchall()]

    except sqlite3.Error as e:
        print(f"Database error during data export for user {user_id}: {e}")
        return "An error occurred while exporting your data. Please contact support.", 500
    finally:
        conn.close()

    # Create a JSON response with a header to trigger download
    return Response(
        json.dumps(data_export, indent=4, default=str),
        mimetype='application/json',
        headers={'Content-Disposition': 'attachment;filename=my_data.json'}
    )

@app.route('/leave-review/<match_id>', methods=['GET', 'POST'])
@login_required
def leave_review(match_id):
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Get match details to identify the parties involved
    cursor.execute("""
        SELECT m.load_id, m.vehicle_id, l.user_id as shipper_id, v.user_id as transporter_id
        FROM matches m
        JOIN loads l ON m.load_id = l.load_id
        JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        WHERE m.match_id = ?
    """, (match_id,))
    match_info = cursor.fetchone()

    if not match_info:
        conn.close()
        return "Match not found", 404

    current_user_id = session['user_id']
    reviewee_id = match_info['transporter_id'] if current_user_id == match_info['shipper_id'] else match_info['shipper_id']

    if current_user_id not in [match_info['shipper_id'], match_info['transporter_id']]:
        conn.close()
        return "You are not part of this transaction.", 403

    if request.method == 'POST':
        # Verify user identity before allowing them to leave a review
        cursor.execute("SELECT id_verified FROM users WHERE user_id = ?", (current_user_id,))
        user_row = cursor.fetchone()
        if not user_row or not user_row['id_verified']:
            conn.close()
            return "You must verify your identity securely via Stripe before you can leave a review.", 403

        rating = request.form.get('rating')
        comment = request.form.get('comment')
        if not rating or not (1 <= int(rating) <= 5):
            return "Invalid rating. Must be between 1 and 5.", 400

        review_id = str(uuid.uuid4())
        cursor.execute("INSERT INTO reviews (review_id, match_id, reviewer_id, reviewee_id, rating, comment, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (review_id, match_id, current_user_id, reviewee_id, int(rating), comment, time.time()))
        conn.commit()
        conn.close()
        return redirect(url_for('profile', user_id=reviewee_id))

    cursor.execute("SELECT username FROM users WHERE user_id = ?", (reviewee_id,))
    reviewee = cursor.fetchone()
    conn.close()
    return render_template('leave_review.html', match_id=match_id, reviewee=reviewee)

@app.route('/request-email-change', methods=['POST'])
@login_required
@limiter.limit("3 per hour")
def request_email_change():
    """Initiates a secure email change by sending a verification link to the new address."""
    new_email = request.form.get('new_email')
    if not new_email:
        return "New email is required.", 400

    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    cursor.execute("SELECT user_id FROM users WHERE email = ?", (new_email,))
    if cursor.fetchone():
        conn.close()
        return "That email address is already in use by another account.", 409
    conn.close()

    token = email_update_serializer.dumps({'user_id': user_id, 'new_email': new_email})
    verify_link = url_for('confirm_email_change', token=token, _external=True)

    text_content = f"Hello,\n\nPlease click the link below to verify and update your email address. This link is valid for 1 hour.\n{verify_link}\n\nIf you did not request this change, please ignore this email."
    
    if send_email(new_email, "Verify Your New Email Address", text_content):
        return "A verification link has been sent to your new email address. Please check your inbox.", 200
    else:
        return "Failed to send verification email. Please try again later.", 500

@app.route('/confirm-email-change/<token>')
def confirm_email_change(token):
    """Verifies the token and permanently updates the user's email in the database."""
    try:
        data = email_update_serializer.loads(token, max_age=3600)
        user_id = data.get('user_id')
        new_email = data.get('new_email')
    except (SignatureExpired, BadTimeSignature):
        return '<h1>Invalid or Expired Link</h1><p>The email verification link has expired or is invalid.</p>', 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET email = ? WHERE user_id = ?", (new_email, user_id))
    conn.commit()
    conn.close()

    return redirect(url_for('edit_profile'))

@app.route('/delete-document/<doc_type>', methods=['POST'])
@login_required
def delete_document(doc_type):
    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("SELECT mc_certificate_path, insurance_path, drivers_license_path FROM users WHERE user_id = ?", (user_id,))
    user_row = cursor.fetchone()
    
    if not user_row:
        conn.close()
        return "User not found", 404

    column_to_clear = None
    file_path = None

    if doc_type == 'mc_cert':
        column_to_clear = 'mc_certificate_path'
        file_path = user_row['mc_certificate_path']
    elif doc_type == 'insurance':
        column_to_clear = 'insurance_path'
        file_path = user_row['insurance_path']
    elif doc_type == 'license':
        column_to_clear = 'drivers_license_path'
        file_path = user_row['drivers_license_path']

    if column_to_clear:
        # Attempt to delete the physical file to save server space
        if file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception as e:
                print(f"Failed to delete file {file_path}: {e}")

        # Remove the reference from the database
        cursor.execute(f"UPDATE users SET {column_to_clear} = NULL WHERE user_id = ?", (user_id,))
        
        # Security measure: If they delete their MC cert, reset their broker verification
        if doc_type == 'mc_cert':
            cursor.execute("UPDATE users SET is_broker_verified = 0 WHERE user_id = ?", (user_id,))
            
        conn.commit()

    conn.close()
    return redirect(url_for('edit_profile'))

@app.route('/edit-profile', methods=['GET', 'POST'])
@login_required
def edit_profile():
    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    if request.method == 'POST':
        bio = request.form.get('bio')
        contact_info = request.form.get('contact_info')
        dot_number = request.form.get('dot_number')
        insurance_expiration_date = request.form.get('insurance_expiration_date')
        
        mc_cert_file = request.files.get('mc_certificate')
        insurance_file = request.files.get('insurance_doc')
        license_file = request.files.get('drivers_license')
        
        mc_cert_path = None
        insurance_path = None
        license_path = None

        if mc_cert_file and mc_cert_file.filename != '':
            filename = secure_filename(mc_cert_file.filename)
            mc_cert_dir = os.path.join(app.config['UPLOAD_FOLDER'], 'mc_certs')
            os.makedirs(mc_cert_dir, exist_ok=True)
            unique_filename = f"mc_cert_{user_id}_{uuid.uuid4().hex[:8]}_{filename}"
            save_path = os.path.join(mc_cert_dir, unique_filename)
            mc_cert_file.save(save_path)
            mc_cert_path = save_path

        if insurance_file and insurance_file.filename != '':
            filename = secure_filename(insurance_file.filename)
            ins_dir = os.path.join(app.config['UPLOAD_FOLDER'], 'insurance_docs')
            os.makedirs(ins_dir, exist_ok=True)
            unique_filename = f"ins_{user_id}_{uuid.uuid4().hex[:8]}_{filename}"
            save_path = os.path.join(ins_dir, unique_filename)
            insurance_file.save(save_path)
            insurance_path = save_path

        if license_file and license_file.filename != '':
            filename = secure_filename(license_file.filename)
            lic_dir = os.path.join(app.config['UPLOAD_FOLDER'], 'driver_licenses')
            os.makedirs(lic_dir, exist_ok=True)
            unique_filename = f"lic_{user_id}_{uuid.uuid4().hex[:8]}_{filename}"
            save_path = os.path.join(lic_dir, unique_filename)
            license_file.save(save_path)
            license_path = save_path

        # Fetch current user state for comparison and verification checks
        cursor.execute("SELECT dot_number, mc_certificate_path, insurance_path, drivers_license_path, id_verified FROM users WHERE user_id = ?", (user_id,))
        user_row = cursor.fetchone()
        
        if user_row and user_row['dot_number'] != dot_number:
            cursor.execute("UPDATE users SET is_broker_verified = 0 WHERE user_id = ?", (user_id,))
            
        final_mc_cert_path = mc_cert_path if mc_cert_path else (user_row['mc_certificate_path'] if user_row else None)
        final_insurance_path = insurance_path if insurance_path else (user_row['insurance_path'] if user_row else None)
        final_license_path = license_path if license_path else (user_row['drivers_license_path'] if user_row else None)
        id_verified = user_row['id_verified'] if user_row else 0

        # --- Automatic "Verified Traveler" Approval ---
        # Automatically grant verified status if all documents are present and insurance is valid.
        is_traveler_verified = 0
        insurance_is_valid = False
        if insurance_expiration_date:
            try:
                exp_date = datetime.datetime.strptime(insurance_expiration_date, '%Y-%m-%d').date()
                if exp_date > datetime.date.today():
                    insurance_is_valid = True
            except (ValueError, TypeError):
                pass # Invalid date format, so insurance is not valid.

        if id_verified and final_insurance_path and final_license_path and insurance_is_valid:
            is_traveler_verified = 1
            print(f"User {user_id} meets criteria. Auto-verifying as Traveler.")

        # Update user profile details
        cursor.execute("""
            UPDATE users 
            SET bio = ?, contact_info = ?, dot_number = ?, mc_certificate_path = ?, insurance_path = ?, drivers_license_path = ?, insurance_expiration_date = ?, is_traveler_verified = ?
            WHERE user_id = ?
        """, (bio, contact_info, dot_number, final_mc_cert_path, final_insurance_path, final_license_path, insurance_expiration_date, is_traveler_verified, user_id))
        
        conn.commit()
        conn.close()
        return redirect(url_for('profile', user_id=user_id))

    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    conn.close()
    
    return render_template('edit_profile.html', user=user)

@app.route('/stripe_onboarding')
@login_required
def stripe_onboarding():
    """Creates a Stripe Connected Account and redirects the user to the onboarding flow."""
    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    
    stripe_account_id = user['stripe_account_id']
    
    # 1. Create the Stripe account if they don't have one yet
    if not stripe_account_id:
        try:
            account = stripe.Account.create(
                type='express',
                email=user['email'],
                capabilities={'transfers': {'requested': True}},
                business_type='individual',
            )
            stripe_account_id = account.id
            cursor.execute("UPDATE users SET stripe_account_id = ? WHERE user_id = ?", (stripe_account_id, user_id))
            conn.commit()
        except Exception as e:
            print(f"Failed to create Stripe account: {e}")
            conn.close()
            return "An error occurred creating your secure payment account.", 500
            
    conn.close()
    
    # 2. Generate a secure, one-time onboarding link and redirect them
    try:
        account_link = stripe.AccountLink.create(
            account=stripe_account_id,
            # If they bail early or the link expires, send them back here to get a new link
            refresh_url=url_for('stripe_onboarding', _external=True),
            # If they finish the flow, send them to the return route
            return_url=url_for('stripe_return', _external=True),
            type='account_onboarding',
        )
        return redirect(account_link.url)
    except Exception as e:
        print(f"Failed to create Stripe account link: {e}")
        return "An error occurred connecting to Stripe.", 500

@app.route('/stripe-return')
@login_required
def stripe_return():
    """Handles the user returning from Stripe and checks if they completed verification."""
    # The actual verification of the account status should ideally be handled via 
    # Stripe's 'account.updated' webhook for security, but we'll do a quick check here too.
    user_id = session['user_id']
    
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT stripe_account_id FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    
    if user and user['stripe_account_id']:
        try:
            account = stripe.Account.retrieve(user['stripe_account_id'])
            # 'details_submitted' means they finished the onboarding flow
            if account.details_submitted:
                cursor.execute("UPDATE users SET id_verified = 1 WHERE user_id = ?", (user_id,))
                conn.commit()
        except Exception as e:
            print(f"Failed to retrieve Stripe account: {e}")
            
    conn.close()
    # Send them back to their profile settings
    return redirect(url_for('edit_profile'))

@app.route('/profile/<user_id>')
def profile(user_id):
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Fetch all user data to get all profile fields
    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    if not user:
        conn.close()
        return "User not found", 404

    # Fetch reviews with associated load description and reviewer ID for links
    cursor.execute("""
        SELECT r.rating, r.comment, r.timestamp, u.username as reviewer_name, r.reviewer_id, l.description as load_description
        FROM reviews r 
        JOIN users u ON r.reviewer_id = u.user_id
        LEFT JOIN matches ma ON r.match_id = ma.match_id
        LEFT JOIN loads l ON ma.load_id = l.load_id
        WHERE r.reviewee_id = ? 
        ORDER BY r.timestamp DESC
    """, (user_id,))
    reviews = cursor.fetchall()
    
    # Fetch rating statistics
    cursor.execute("SELECT AVG(rating) as avg_rating, COUNT(rating) as rating_count FROM reviews WHERE reviewee_id = ?", (user_id,))
    rating_stats = cursor.fetchone()
    
    # Fetch user's public listings to prevent template errors
    cursor.execute("SELECT * FROM loads WHERE user_id = ? AND is_flagged = 0 ORDER BY timestamp DESC", (user_id,))
    loads = cursor.fetchall()
    cursor.execute("SELECT * FROM vehicles WHERE user_id = ? ORDER BY timestamp DESC", (user_id,))
    trucks = cursor.fetchall()
    
    # The template expects these, so we provide empty lists to avoid errors
    completed_matches = []
    asap_loads = []
    
    conn.close()
    
    return render_template('profile.html', 
                           user=user, 
                           reviews=reviews, 
                           rating_stats=rating_stats,
                           loads=loads,
                           trucks=trucks,
                           completed_matches=completed_matches,
                           asap_loads=asap_loads)

@app.route('/document/<user_id>/<doc_type>')
@login_required
def serve_user_doc(user_id, doc_type):
    """Serves user profile documents securely to logged-in users."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT mc_certificate_path, insurance_path, drivers_license_path FROM users WHERE user_id = ?", (user_id,))
    user_row = cursor.fetchone()
    conn.close()

    if not user_row:
        return "User not found", 404

    path = None
    if doc_type == 'mc_cert':
        path = user_row['mc_certificate_path']
    elif doc_type == 'insurance':
        path = user_row['insurance_path']
    elif doc_type == 'license':
        path = user_row['drivers_license_path']

    if not path or not os.path.exists(path):
        return "Document not found", 404

    directory, filename = os.path.split(path)
    return send_from_directory(directory, filename)

@app.route('/inbox')
@login_required
def inbox():
    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
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
    conn.close()
    return render_template('inbox.html', conversations=conversations)

@app.route('/chat/<other_user_id>', methods=['GET', 'POST'])
@login_required
def chat(other_user_id):
    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
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
            conn.close()
            return "You must verify your identity securely via Stripe before you can send messages.", 403

        content = request.form.get('content')
        if content:
            filtered_content = filter_message_content(content)
            message_id = str(uuid.uuid4())
            cursor.execute("INSERT INTO messages (message_id, sender_id, receiver_id, content, timestamp) VALUES (?, ?, ?, ?, ?)",
                           (message_id, user_id, other_user_id, filtered_content, time.time()))
            conn.commit()
            return redirect(url_for('chat', other_user_id=other_user_id))

    # Check that the user we're chatting with exists
    cursor.execute("SELECT username FROM users WHERE user_id = ?", (other_user_id,))
    other_user = cursor.fetchone()
    if not other_user:
        conn.close()
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
    conn.close()
    
    return render_template('chat.html', messages=messages, other_user=other_user, other_user_id=other_user_id)

@app.route('/admin/dashboard')
@admin_required
def admin_dashboard():
    """Displays all flagged loads requiring admin review."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Pagination setup for dispute evidence
    page = request.args.get('page', 1, type=int)
    per_page = 10
    offset = (page - 1) * per_page

    cursor.execute("""
        SELECT l.*, u.username, u.email, u.mc_certificate_path
        FROM loads l 
        JOIN users u ON l.user_id = u.user_id 
        WHERE l.is_flagged = 1 
        ORDER BY l.timestamp DESC
    """)
    flagged_loads = cursor.fetchall()
    
    # Get total count to calculate total pages
    cursor.execute("SELECT COUNT(*) FROM dispute_evidence")
    total_evidence = cursor.fetchone()[0]
    total_pages = (total_evidence + per_page - 1) // per_page if total_evidence > 0 else 1

    # Fetch the history of all submitted dispute evidence
    cursor.execute("""
        SELECT de.*, u.username, l.description as load_description, l.stripe_dispute_id, l.admin_notes
        FROM dispute_evidence de
        JOIN users u ON de.user_id = u.user_id
        JOIN loads l ON de.load_id = l.load_id
        ORDER BY de.timestamp DESC
        LIMIT ? OFFSET ?
    """, (per_page, offset))
    dispute_evidence = cursor.fetchall()
    conn.close()
    
    return render_template('admin_dashboard.html', flagged_loads=flagged_loads, dispute_evidence=dispute_evidence, current_page=page, total_pages=total_pages)

@app.route('/admin/approve-load/<load_id>', methods=['POST'])
@admin_required
def approve_load(load_id):
    """Approves a flagged load, removing the flag."""
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("UPDATE loads SET is_flagged = 0 WHERE load_id = ?", (load_id,))
    conn.commit()
    conn.close()
    print(f"Admin approved flagged load {load_id}")
    return redirect(url_for('admin_dashboard'))

@app.route('/admin/delete-load/<load_id>', methods=['POST'])
@admin_required
def delete_load(load_id):
    """Deletes a suspicious load entirely from the platform."""
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM loads WHERE load_id = ?", (load_id,))
    conn.commit()
    conn.close()
    print(f"Admin deleted flagged load {load_id}")
    return redirect(url_for('admin_dashboard'))

@app.route('/admin/add-note/<load_id>', methods=['POST'])
@admin_required
def add_admin_note(load_id):
    """Allows an administrator to save private, internal notes regarding a load or dispute."""
    note = request.form.get('admin_notes')
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("UPDATE loads SET admin_notes = ? WHERE load_id = ?", (note, load_id))
    conn.commit()
    conn.close()
    return redirect(url_for('admin_dashboard'))

@app.route('/admin/export-evidence-csv')
@admin_required
def export_evidence_csv():
    """Exports the dispute evidence history as a CSV file for administrators."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT de.evidence_id, de.timestamp, u.username, l.description as load_description, 
               l.stripe_dispute_id, de.comments, de.file_path
        FROM dispute_evidence de
        JOIN users u ON de.user_id = u.user_id
        JOIN loads l ON de.load_id = l.load_id
        ORDER BY de.timestamp DESC
    """)
    evidence_records = cursor.fetchall()
    conn.close()
    
    output = io.StringIO()
    writer = csv.writer(output)
    
    writer.writerow(['Evidence ID', 'Date', 'User', 'Load Description', 'Dispute ID', 'Comments', 'Attachment Path'])
    
    for row in evidence_records:
        date_str = datetime.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d %H:%M:%S') if row['timestamp'] else ''
        writer.writerow([
            row['evidence_id'], date_str, row['username'], row['load_description'],
            row['stripe_dispute_id'] or 'N/A', row['comments'], row['file_path'] or 'No file'
        ])
        
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-disposition": "attachment; filename=dispute_evidence_history.csv"}
    )

@app.route('/admin/analytics', methods=['GET'])
@admin_required
def admin_analytics():
    """Returns core platform analytics like dispute rates and total escrow volume in JSON format."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # 1. Total Users Breakdown
    cursor.execute("SELECT role, COUNT(*) as count FROM users GROUP BY role")
    users_by_role = {row['role']: row['count'] for row in cursor.fetchall()}

    # 2. Escrow Volume (Summing active, successful, and disputed payouts)
    cursor.execute("SELECT SUM(CAST(offer AS REAL)) as total_volume FROM loads WHERE payment_status IN ('paid', 'dispute_under_review', 'dispute_won', 'dispute_lost')")
    volume_row = cursor.fetchone()
    total_volume = volume_row['total_volume'] if volume_row['total_volume'] else 0

    # 3. Dispute Metrics
    cursor.execute("SELECT COUNT(*) as total FROM loads WHERE payment_status IN ('paid', 'disputed', 'dispute_under_review', 'dispute_won', 'dispute_lost')")
    total_completed_loads = cursor.fetchone()['total']

    cursor.execute("SELECT COUNT(*) as total FROM loads WHERE payment_status IN ('disputed', 'dispute_under_review', 'dispute_won', 'dispute_lost')")
    total_disputes = cursor.fetchone()['total']

    dispute_rate = (total_disputes / total_completed_loads * 100) if total_completed_loads > 0 else 0

    conn.close()

    return jsonify({
        'users': users_by_role,
        'total_escrow_volume_usd': total_volume,
        'total_completed_loads': total_completed_loads,
        'total_disputes': total_disputes,
        'dispute_rate_percentage': round(dispute_rate, 2)
    })

def cleanup_expired_listings():
    """
    Checks for expired vehicle and load listings, removes them,
    and prints a notification to simulate contacting the parties.
    """
    print("Connecting to database to clean up expired listings...")
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    today = datetime.date.today().isoformat() # 'YYYY-MM-DD'

    # --- 1. Handle expired vehicles (transporters) ---
    # Find vehicles where the end_date has passed
    cursor.execute("""
        SELECT v.vehicle_id, v.departure_city, v.destination_city, u.username 
        FROM vehicles v JOIN users u ON v.user_id = u.user_id 
        WHERE v.end_date < ?
    """, (today,))
    expired_vehicles = cursor.fetchall()

    for vehicle in expired_vehicles:
        vehicle_id, departure, destination, username = vehicle
        print(f"\n--- NOTIFICATION ---")
        print(f"To {username} (transporter of vehicle {vehicle_id}, Route: {departure}-{destination}):")
        print(f"Your listing has expired. Would you like to renew it with updated dates?")
        print(f"--------------------\n")

    # Delete expired vehicles
    if expired_vehicles:
        cursor.execute("DELETE FROM vehicles WHERE end_date < ?", (today,))
        print(f"Removed {len(expired_vehicles)} expired vehicle listing(s).")

    # --- 2. Handle expired loads (shippers) ---
    # Find loads where the shipping_date has passed
    cursor.execute("""
        SELECT l.load_id, l.description, u.username 
        FROM loads l JOIN users u ON l.user_id = u.user_id 
        WHERE l.shipping_date < ?
    """, (today,))
    expired_loads = cursor.fetchall()

    for load in expired_loads:
        load_id, description, username = load
        print(f"\n--- NOTIFICATION ---")
        print(f"To {username} (shipper of load {load_id}, '{description}'):")
        print(f"Your load listing has expired. Would you like to renew it with an updated shipping date?")
        print(f"--------------------\n")

    # Delete expired loads
    if expired_loads:
        cursor.execute("DELETE FROM loads WHERE shipping_date < ?", (today,))
        print(f"Removed {len(expired_loads)} expired load listing(s).")

    conn.commit()
    conn.close()
    print("\nCleanup of expired listings complete.")

def revoke_invalid_verifications():
    """
    Daily task to revoke 'Verified Broker' or 'Verified Traveler' status if their
    required documents are missing.
    """
    print("Checking for invalid verifications...")
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # --- Broker Verification Check ---
    cursor.execute("""
        SELECT email, username
        FROM users 
        WHERE is_broker_verified = 1 
        AND (mc_certificate_path IS NULL OR mc_certificate_path = '')
    """)
    brokers_to_revoke = cursor.fetchall()
    
    if brokers_to_revoke:
        # Revoke their status
        cursor.execute("""
            UPDATE users 
            SET is_broker_verified = 0 
            WHERE is_broker_verified = 1 
            AND (mc_certificate_path IS NULL OR mc_certificate_path = '')
        """)
        
        for user in brokers_to_revoke:
            email = user['email']
            username = user['username']
            
            if email:
                text_content = f"Hello {username},\n\nYour 'Verified Broker' status on GottaBackhaul has been revoked because your MC Certificate is missing from your profile.\n\nPlease log in and upload a valid MC Certificate to regain your verified status.\n\nThank you,\nThe GottaBackhaul Team"
                send_email(email, "Action Required: Verified Broker Status Revoked", text_content)
                    
        print(f"Revoked 'Verified Broker' status for {len(brokers_to_revoke)} user(s) due to missing MC Certificate.")

    # --- Traveler Verification Check ---
    cursor.execute("""
        SELECT email, username
        FROM users
        WHERE is_traveler_verified = 1
        AND (drivers_license_path IS NULL OR drivers_license_path = '')
    """)
    travelers_to_revoke = cursor.fetchall()

    if travelers_to_revoke:
        # Revoke their status
        cursor.execute("""
            UPDATE users
            SET is_traveler_verified = 0
            WHERE is_traveler_verified = 1
            AND (drivers_license_path IS NULL OR drivers_license_path = '')
        """)

        for user in travelers_to_revoke:
            email = user['email']
            username = user['username']

            if email:
                text_content = f"Hello {username},\n\nYour 'Verified Traveler' status on GottaBackhaul has been revoked because your Driver's License is missing from your profile.\n\nPlease log in and upload a valid Driver's License to regain your verified status.\n\nThank you,\nThe GottaBackhaul Team"
                send_email(email, "Action Required: Verified Traveler Status Revoked", text_content)

        print(f"Revoked 'Verified Traveler' status for {len(travelers_to_revoke)} user(s) due to missing Driver's License.")

    conn.commit()
    conn.close()
    print("Invalid verification cleanup complete.\n")

def seed_dummy_data():
    """Generates dummy users, loads, and vehicles for UI testing."""
    print("Seeding database with dummy data...")
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    shipper_id = str(uuid.uuid4())
    driver_id = str(uuid.uuid4())
    pass_hash = generate_password_hash("Password123!")
    
    try:
        cursor.execute("INSERT INTO users (user_id, username, email, password_hash, role, id_verified) VALUES (?, ?, ?, ?, ?, ?)",
            (shipper_id, "test_shipper", "shipper@example.com", pass_hash, "shipper", 1))
        cursor.execute("INSERT INTO users (user_id, username, email, password_hash, role, id_verified) VALUES (?, ?, ?, ?, ?, ?)",
            (driver_id, "test_driver", "driver@example.com", pass_hash, "transporter", 1))
    except sqlite3.IntegrityError:
        print("Test users already exist. Appending data to existing users.")
        cursor.execute("SELECT user_id FROM users WHERE username = 'test_shipper'")
        res = cursor.fetchone()
        if res: shipper_id = res[0]
        cursor.execute("SELECT user_id FROM users WHERE username = 'test_driver'")
        res = cursor.fetchone()
        if res: driver_id = res[0]

    loads_data = [
        (str(uuid.uuid4()), shipper_id, "Pallet of Electronics", "500 lbs", "48x48x48", "New York, NY", "Chicago, IL", "350", time.time(), (datetime.date.today() + timedelta(days=2)).isoformat(), "unpaid", 0),
        (str(uuid.uuid4()), shipper_id, "Office Furniture", "1200 lbs", "Various", "Austin, TX", "Indianapolis, IN", "800", time.time(), (datetime.date.today() + timedelta(days=5)).isoformat(), "unpaid", 0)
    ]
    cursor.executemany("INSERT INTO loads (load_id, user_id, description, weight, dimensions, pickup, delivery, offer, timestamp, shipping_date, payment_status, is_flagged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", loads_data)

    vehicles_data = [
        (str(uuid.uuid4()), driver_id, "Cargo Van", "Philadelphia, PA", "Chicago, IL", datetime.date.today().isoformat(), (datetime.date.today() + timedelta(days=7)).isoformat(), "2000 lbs", "120x60x60", time.time()),
        (str(uuid.uuid4()), driver_id, "Flatbed", "Los Angeles, CA", "Seattle, WA", datetime.date.today().isoformat(), (datetime.date.today() + timedelta(days=10)).isoformat(), "45000 lbs", "48ft", time.time())
    ]
    cursor.executemany("INSERT INTO vehicles (vehicle_id, user_id, vehicle_type, departure_city, destination_city, start_date, end_date, max_weight, max_dimensions, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", vehicles_data)

    conn.commit()
    conn.close()
    print("Dummy data seeded successfully! You can login with 'test_shipper' or 'test_driver' (Password: Password123!).")

if __name__ == '__main__':
    import sys
    init_db() # Ensure DB and tables exist
    if len(sys.argv) > 1:
        if sys.argv[1] == 'cleanup':
            cleanup_expired_listings()
            revoke_invalid_verifications()
        elif sys.argv[1] == 'seed':
            seed_dummy_data()
    else:
        app.run(debug=True)
