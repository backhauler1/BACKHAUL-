import os
import re
import time
import logging
from logging.handlers import TimedRotatingFileHandler, SMTPHandler
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
from flask import Flask, request, jsonify, render_template, session, redirect, url_for, send_from_directory, Response, g
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix
from itsdangerous import URLSafeTimedSerializer, SignatureExpired, BadTimeSignature
from dotenv import load_dotenv
from flask_apscheduler import APScheduler
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

# Load environment variables from a .env file
load_dotenv()

# --- Database Setup ---
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DATABASE = os.path.join(BASE_DIR, 'trucking.db')

# --- Logging Setup ---
LOG_DIR = os.path.join(BASE_DIR, 'logs')
os.makedirs(LOG_DIR, exist_ok=True)

# --- Email Alert Handler Setup ---
admin_email = os.environ.get("ADMIN_EMAIL", "gottabackhaul@gmail.com")
gmail_password = os.environ.get("GMAIL_APP_PASSWORD")
mail_handler = None

if gmail_password:
    mail_handler = SMTPHandler(
        mailhost=('smtp.gmail.com', 587),
        fromaddr="gottabackhaul@gmail.com",
        toaddrs=[admin_email],
        subject='🚨 GottaBackhaul: Critical Error Alert',
        credentials=("gottabackhaul@gmail.com", gmail_password),
        secure=()
    )
    # ONLY send emails for errors and critical exceptions, not info/warnings
    mail_handler.setLevel(logging.ERROR) 
    mail_handler.setFormatter(logging.Formatter(
        'Time:               %(asctime)s\n'
        'Message type:       %(levelname)s\n'
        'Location:           %(pathname)s:%(lineno)d\n'
        'Module:             %(module)s\n'
        'Function:           %(funcName)s\n\n'
        'Message:\n'
        '%(message)s\n'
    ))

# Set up a specific logger for scheduled jobs
scheduler_logger = logging.getLogger('scheduled_jobs')
scheduler_logger.setLevel(logging.INFO)
# Set up a timed rotating file handler: rotates at midnight, keeps last 5 days
job_log_handler = TimedRotatingFileHandler(
    os.path.join(LOG_DIR, 'scheduled_jobs.log'),
    when='midnight', interval=1, backupCount=5
)
job_log_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
scheduler_logger.addHandler(job_log_handler)
if mail_handler:
    scheduler_logger.addHandler(mail_handler)

# Optionally route APScheduler's internal logs here too
apscheduler_logger = logging.getLogger('apscheduler')
apscheduler_logger.setLevel(logging.INFO)
apscheduler_logger.addHandler(job_log_handler)
if mail_handler:
    apscheduler_logger.addHandler(mail_handler)

# Set up a handler for web server logs (access and errors)
web_log_handler = TimedRotatingFileHandler(
    os.path.join(LOG_DIR, 'web_app.log'),
    when='midnight', interval=1, backupCount=5
)
web_log_handler.setFormatter(logging.Formatter(
    '%(asctime)s - %(name)s - %(levelname)s - %(message)s [in %(pathname)s:%(lineno)d]'
))

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

    # Safely attempt to add the signature_required column for delivery confirmation
    try:
        cursor.execute("ALTER TABLE loads ADD COLUMN signature_required INTEGER DEFAULT 0")
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

    # Safely attempt to add a 'note' column for geofencing warnings
    try:
        cursor.execute("ALTER TABLE delivery_proofs ADD COLUMN note TEXT")
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
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'delivery_proofs')

app = Flask(__name__)

# --- Web Logger Configuration ---
# Get the Werkzeug logger (for access logs) and add the handler.
# This will log requests like "GET / HTTP/1.1" 200 -
werkzeug_logger = logging.getLogger('werkzeug')
werkzeug_logger.setLevel(logging.INFO)
werkzeug_logger.addHandler(web_log_handler)

# Add the handler to the main Flask app logger.
# This is for your own app.logger.info() calls and unhandled exceptions.
app.logger.addHandler(web_log_handler)
if mail_handler:
    app.logger.addHandler(mail_handler)
app.logger.setLevel(logging.INFO)

app.secret_key = os.environ.get('FLASK_SECRET_KEY', os.urandom(24)) # Use a static env variable to prevent token invalidation on reboot
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
# Keep users logged in for 30 days for easy browsing
app.permanent_session_lifetime = timedelta(days=30)

# --- Database Connection Pooling (Per-Request) ---
def get_db():
    """Opens a new database connection if there is none yet for the current application context."""
    if not hasattr(g, 'sqlite_db'):
        g.sqlite_db = sqlite3.connect(DATABASE)
        g.sqlite_db.row_factory = sqlite3.Row
    return g.sqlite_db

@app.teardown_appcontext
def close_db(error):
    """Closes the database again at the end of the request."""
    if hasattr(g, 'sqlite_db'):
        g.sqlite_db.close()

# --- Scheduler Setup ---
scheduler = APScheduler()


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

ALLOWED_IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp'}
ALLOWED_DOC_EXTENSIONS = {'pdf', 'png', 'jpg', 'jpeg', 'doc', 'docx'}

def allowed_file(filename, allowed_extensions):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in allowed_extensions

# Serializer for generating secure, timed tokens for magic links
s = URLSafeTimedSerializer(app.secret_key, salt='magic-link-salt')
# Serializer for password resets
reset_serializer = URLSafeTimedSerializer(app.secret_key, salt='password-reset-salt')
# Serializer for email updates
email_update_serializer = URLSafeTimedSerializer(app.secret_key, salt='email-update-salt')
# Serializer for new account email verification
verification_serializer = URLSafeTimedSerializer(app.secret_key, salt='email-verification-salt')

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
            return redirect(url_for('auth.login', next=request.url))
            
        # Verify session version to support logging out of all devices
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("SELECT session_version FROM users WHERE user_id = ?", (session['user_id'],))
        row = cursor.fetchone()
        conn.close()
        
        if not row or session.get('session_version', 1) != (row[0] or 1):
            session.clear()
            return redirect(url_for('auth.login', next=request.url))
            
        return f(*args, **kwargs)
    return decorated_function

# --- Admin Authentication Decorator ---
def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('auth.login', next=request.url))
            
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
            return redirect(url_for('auth.login', next=request.url))
        if not session.get('is_verified'):
            session['next_url'] = request.url
            return redirect(url_for('auth.verify_identity'))
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

@app.route('/privacy-policy')
def privacy_policy():
    return render_template('privacy.html')

@app.route('/terms-of-service')
def terms_of_service():
    return render_template('terms.html')

@app.route('/available-loads')
def available_loads():
    conn = get_db()
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
    return render_template('loads.html', loads=loads)

@app.route('/available-vehicles')
def available_vehicles():
    conn = get_db()
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
    return render_template('trucks.html', trucks=vehicles)

@app.route('/dashboard')
@login_required
def dashboard():
    user_id = session['user_id']
    role = session['role']
    
    conn = get_db()
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

        # Fetch delivery proof details for this load, if available
        cursor.execute("SELECT image_path, signature, note FROM delivery_proofs WHERE load_id = ?", (match_dict['load_id'],))
        pod_info = cursor.fetchone()
        if pod_info:
            match_dict['pod_photo_path'] = pod_info['image_path']
            match_dict['pod_signature_path'] = pod_info['signature']
            match_dict['pod_note'] = pod_info['note'] # Add the note here
        
        
        cursor.execute("SELECT 1 FROM reviews WHERE match_id = ? AND reviewer_id = ?", (match_dict['match_id'], user_id))
        match_dict['review_left'] = bool(cursor.fetchone())
        matches.append(match_dict)

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

def cleanup_expired_listings():
    """
    Checks for expired vehicle and load listings, removes them,
    and logs a notification to simulate contacting the parties.
    """
    scheduler_logger.info("Connecting to database to clean up expired listings...")
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
        scheduler_logger.info(f"Notification to {username} (transporter of vehicle {vehicle_id}, Route: {departure}-{destination}): Your listing has expired. Would you like to renew it with updated dates?")

    # Delete expired vehicles
    if expired_vehicles:
        cursor.execute("DELETE FROM vehicles WHERE end_date < ?", (today,))
        scheduler_logger.info(f"Removed {len(expired_vehicles)} expired vehicle listing(s).")

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
        scheduler_logger.info(f"Notification to {username} (shipper of load {load_id}, '{description}'): Your load listing has expired. Would you like to renew it with an updated shipping date?")

    # Delete expired loads
    if expired_loads:
        cursor.execute("DELETE FROM loads WHERE shipping_date < ?", (today,))
        scheduler_logger.info(f"Removed {len(expired_loads)} expired load listing(s).")

    conn.commit()
    conn.close()
    scheduler_logger.info("Cleanup of expired listings complete.")

def send_insurance_expiration_warnings():
    """
    Finds users whose insurance is expiring in 7 days and sends a warning email.
    This is the integrated version of the logic from send_insurance_warnings.py.
    """
    scheduler_logger.info("Starting daily insurance expiration check...")
    days_away = 7
    target_date = (datetime.date.today() + timedelta(days=days_away)).isoformat()

    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT username, email, insurance_expiration_date FROM users WHERE insurance_expiration_date = ?", (target_date,))
        users_to_warn = cursor.fetchall()

        if not users_to_warn:
            scheduler_logger.info(f"No users with insurance expiring in {days_away} days.")
        else:
            scheduler_logger.info(f"Found {len(users_to_warn)} user(s) with insurance expiring soon.")
            for user in users_to_warn:
                # Re-use the existing send_email helper
                subject = "Your GottaBackhaul Insurance is Expiring Soon!"
                # Construct the link to the profile page, now in a blueprint
                profile_link = url_for('profile.edit_profile', _external=True)
                body = f"""
Hi {user['username']},

This is a friendly reminder that your insurance policy on file with GottaBackhaul is set to expire in 7 days, on {datetime.datetime.strptime(user['insurance_expiration_date'], '%Y-%m-%d').strftime('%B %d, %Y')}.

To avoid any interruption to your "Verified Traveler" status and to remain eligible for jobs that require insurance, please log in to your dashboard and upload your new policy documents as soon as possible.

You can update your profile here: {profile_link}

Thank you,
The GottaBackhaul Team
"""
                # Use the existing, robust email function
                send_email(user['email'], subject, body)

    except Exception as e:
        scheduler_logger.error(f"An error occurred during the insurance warning job: {e}")
    finally:
        conn.close()

    scheduler_logger.info("Finished daily insurance expiration check.")


def revoke_invalid_verifications():
    """
    Daily task to revoke 'Verified Broker' or 'Verified Traveler' status if their
    required documents are missing.
    """
    scheduler_logger.info("Checking for invalid verifications...")
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # --- Broker Verification Check ---
    cursor.execute("""
        SELECT user_id, email, username, dot_number, mc_certificate_path
        FROM users 
        WHERE is_broker_verified = 1 
    """)
    brokers = cursor.fetchall()
    
    brokers_to_revoke = []
    for user in brokers:
        # Revoke if certificate was deleted
        if not user['mc_certificate_path']:
            brokers_to_revoke.append((user, "your MC Certificate is missing from your profile"))
            continue
            
        # If they have a DOT number, verify it's still ACTIVE via the live FMCSA API
        if user['dot_number']:
            is_active = verify_fmcsa_broker(user['dot_number'])
            if not is_active:
                brokers_to_revoke.append((user, f"the FMCSA database indicates that DOT number {user['dot_number']} is no longer an active broker"))

    if brokers_to_revoke:
        for user_data, reason in brokers_to_revoke:
            user = user_data
            # Revoke their status
            cursor.execute("UPDATE users SET is_broker_verified = 0 WHERE user_id = ?", (user['user_id'],))
            
            if user['email']:
                text_content = f"Hello {user['username']},\n\nYour 'Verified Broker' status on GottaBackhaul has been revoked because {reason}.\n\nPlease log in and update your compliance details to regain your verified status.\n\nThank you,\nThe GottaBackhaul Team"
                send_email(user['email'], "Action Required: Verified Broker Status Revoked", text_content)
                    
        scheduler_logger.info(f"Revoked 'Verified Broker' status for {len(brokers_to_revoke)} user(s).")

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

        scheduler_logger.info(f"Revoked 'Verified Traveler' status for {len(travelers_to_revoke)} user(s) due to missing Driver's License.")

    conn.commit()
    conn.close()
    scheduler_logger.info("Invalid verification cleanup complete.")

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

# --- Register Blueprints ---
from payments import payments_bp
app.register_blueprint(payments_bp)

# Register the authentication blueprint
from auth import auth_bp
app.register_blueprint(auth_bp)

# Register the profile blueprint
from profile import profile_bp
app.register_blueprint(profile_bp)

# Register the shipments blueprint
from shipments import shipments_bp
app.register_blueprint(shipments_bp)

# Register the messaging blueprint
from messaging import messaging_bp
app.register_blueprint(messaging_bp)

# Register the admin blueprint
from admin import admin_bp
app.register_blueprint(admin_bp)

# Register the tracking blueprint
from tracking import tracking_bp
app.register_blueprint(tracking_bp)

if __name__ == '__main__':
    import sys
    init_db() # Ensure DB and tables exist

    # The 'seed' command can remain for development purposes
    if len(sys.argv) > 1 and sys.argv[1] == 'seed':
        seed_dummy_data()
    else:
        # Configure and start the scheduler
        app.config["SCHEDULER_API_ENABLED"] = False # We don't need the scheduler's REST API
        scheduler.init_app(app)

        # Define the jobs using the scheduler instance.
        # These will run in the background when the app is running.
        @scheduler.task('cron', id='daily_maintenance', hour=2, minute=0)
        def daily_maintenance_job():
            with scheduler.app.app_context():
                scheduler_logger.info("Running daily maintenance job...")
                cleanup_expired_listings()
                revoke_invalid_verifications()
                scheduler_logger.info("Daily maintenance job finished.")

        @scheduler.task('cron', id='insurance_warning_job', hour=3, minute=0)
        def insurance_warning_job():
            with scheduler.app.app_context():
                send_insurance_expiration_warnings()

        scheduler.start()
        
        app.run(debug=True, use_reloader=False) # use_reloader=False is important for APScheduler
