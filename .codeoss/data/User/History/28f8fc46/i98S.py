import pytest
import sqlite3
import os
import io
import uuid
import time
from flask import Flask, session
from werkzeug.datastructures import FileStorage

# Assuming DATABASE is defined in main.py and accessible
from main import DATABASE, tracking_bp # Import the blueprint

# Mock the allowed_file function and ALLOWED_IMAGE_EXTENSIONS from main
# for isolated testing of the tracking blueprint.
ALLOWED_IMAGE_EXTENSIONS_MOCK = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
def allowed_file_mock(filename, extensions):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in extensions

# --- Fixtures ---

@pytest.fixture
def app():
    """Create and configure a new app instance for each test."""
    app = Flask(__name__)
    app.config.from_mapping(
        TESTING=True,
        SECRET_KEY='dev', # Use a simple secret key for testing
        DATABASE=DATABASE,
        UPLOAD_FOLDER='test_uploads' # Use a specific upload folder for tests
    )

    # Register the blueprint
    app.register_blueprint(tracking_bp)

    # Initialize the database for testing
    with app.app_context():
        # Ensure the database is clean for each test
        conn = sqlite3.connect(app.config['DATABASE'])
        cursor = conn.cursor()
        cursor.execute("DROP TABLE IF EXISTS users")
        cursor.execute("DROP TABLE IF EXISTS loads")
        cursor.execute("DROP TABLE IF EXISTS delivery_proofs")
        cursor.execute("DROP TABLE IF EXISTS matches")
        cursor.execute("DROP TABLE IF EXISTS vehicles")
        cursor.execute("DROP TABLE IF EXISTS locations")
        cursor.execute("DROP TABLE IF EXISTS dispute_evidence")
        
        # Create tables needed for tracking.py
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL,
                is_email_verified INTEGER DEFAULT 0,
                id_verified INTEGER DEFAULT 0,
                dot_number TEXT,
                is_broker_verified INTEGER DEFAULT 0,
                mc_certificate_path TEXT,
                is_traveler_verified INTEGER DEFAULT 0
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS loads (
                load_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                description TEXT,
                weight TEXT,
                dimensions TEXT,
                pickup TEXT,
                delivery TEXT,
                offer REAL,
                shipping_date TEXT,
                timestamp REAL,
                ip_address TEXT,
                is_flagged INTEGER DEFAULT 0,
                payment_status TEXT DEFAULT 'unpaid',
                FOREIGN KEY (user_id) REFERENCES users (user_id)
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS delivery_proofs (
                proof_id INTEGER PRIMARY KEY AUTOINCREMENT,
                load_id TEXT NOT NULL,
                signature TEXT,
                image_path TEXT,
                latitude REAL,
                longitude REAL,
                timestamp REAL NOT NULL,
                note TEXT,
                FOREIGN KEY (load_id) REFERENCES loads (load_id)
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS matches (
                match_id TEXT PRIMARY KEY,
                load_id TEXT NOT NULL,
                vehicle_id TEXT NOT NULL,
                timestamp REAL NOT NULL,
                FOREIGN KEY (load_id) REFERENCES loads (load_id),
                FOREIGN KEY (vehicle_id) REFERENCES vehicles (vehicle_id)
            )
        """)
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
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS locations (
                load_id TEXT PRIMARY KEY,
                latitude REAL,
                longitude REAL,
                timestamp REAL,
                FOREIGN KEY (load_id) REFERENCES loads (load_id)
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS dispute_evidence (
                dispute_id INTEGER PRIMARY KEY AUTOINCREMENT,
                load_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                comments TEXT,
                timestamp REAL,
                FOREIGN KEY (load_id) REFERENCES loads (load_id),
                FOREIGN KEY (user_id) REFERENCES users (user_id)
            )
        """)
        conn.commit()
        conn.close()
    yield app

@pytest.fixture
def client(app):
    """A test client for the app."""
    return app.test_client()

@pytest.fixture
def add_user(app):
    """Fixture to add a user to the test database."""
    def _add_user(username, email, password, role="transporter", is_email_verified=1, id_verified=1):
        user_id = str(uuid.uuid4())
        with app.app_context():
            conn = sqlite3.connect(app.config['DATABASE'])
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO users (user_id, username, email, password, role, is_email_verified, id_verified) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (user_id, username, email, password, role, is_email_verified, id_verified)
            )
            conn.commit()
            conn.close()
        return {'user_id': user_id, 'username': username, 'email': email, 'password': password, 'role': role}
    return _add_user

@pytest.fixture
def create_load(app):
    """Fixture to create a load in the test database."""
    def _create_load(user_id, description="Test Load", delivery="123 Main St, Anytown, USA", load_id=None):
        load_id = load_id if load_id else str(uuid.uuid4())
        with app.app_context():
            conn = sqlite3.connect(app.config['DATABASE'])
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO loads (load_id, user_id, description, delivery, timestamp) VALUES (?, ?, ?, ?, ?)",
                (load_id, user_id, description, delivery, time.time())
            )
            conn.commit()
            conn.close()
        return {'load_id': load_id, 'user_id': user_id, 'description': description, 'delivery': delivery}
    return _create_load

@pytest.fixture
def mock_upload_folder(app):
    """Create a temporary upload folder for tests and clean it up."""
    upload_dir = os.path.join(app.root_path, app.config['UPLOAD_FOLDER'])
    os.makedirs(upload_dir, exist_ok=True)
    yield upload_dir
    # Clean up after tests
    for f in os.listdir(upload_dir):
        os.remove(os.path.join(upload_dir, f))
    os.rmdir(upload_dir)

# --- Test Cases ---

def test_delivery_confirmation_photo_upload_success(client, app, add_user, create_load, mock_upload_folder, monkeypatch):
    """
    Tests successful delivery confirmation photo upload within geofence.
    """
    # Mock external dependencies
    monkeypatch.setattr('main.allowed_file', allowed_file_mock)
    monkeypatch.setattr('main.ALLOWED_IMAGE_EXTENSIONS', ALLOWED_IMAGE_EXTENSIONS_MOCK)
    monkeypatch.setattr('main.geocode_address', lambda addr: (34.0522, -118.2437)) # Los Angeles
    monkeypatch.setattr('main.calculate_distance', lambda lat1, lon1, lat2, lon2: 0.5) # Within 1 mile
    
    mock_send_email_called = False
    def mock_send_email(*args, **kwargs):
        nonlocal mock_send_email_called
        mock_send_email_called = True
        return True
    monkeypatch.setattr('main.send_email', mock_send_email)

    mock_release_escrow_funds_called = False
    def mock_release_escrow_funds(*args, **kwargs):
        nonlocal mock_release_escrow_funds_called
        mock_release_escrow_funds_called = True
        return True
    monkeypatch.setattr('payments.release_escrow_funds', mock_release_escrow_funds)

    # 1. Create a transporter user and a load
    transporter = add_user("transporter_pod", "transporter@example.com", "password123")
    load = create_load(transporter['user_id'], delivery="Los Angeles, CA")

    # 2. Log in the transporter
    with client:
        client.post('/login', data={'username': transporter['username'], 'password': transporter['password']})
        with client.session_transaction() as s:
            s['user_id'] = transporter['user_id']
            s['username'] = transporter['username']
            s['role'] = transporter['role']

        # 3. Prepare a dummy image file
        data = {
            'load_id': load['load_id'],
            'latitude': '34.0525',
            'longitude': '-118.2440',
            'delivery_proof_pic': (io.BytesIO(b"dummy image content"), 'proof.jpg')
        }
        
        response = client.post('/delivery-confirmation', data=data, content_type='multipart/form-data')

        # 4. Assert the response
        assert response.status_code == 200
        assert b"Delivery confirmed successfully!" in response.data

        # 5. Verify database entry
        with app.app_context():
            conn = sqlite3.connect(app.config['DATABASE'])
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM delivery_proofs WHERE load_id = ?", (load['load_id'],))
            proof_entry = cursor.fetchone()
            conn.close()

        assert proof_entry is not None
        assert proof_entry['image_path'].startswith(mock_upload_folder)
        assert proof_entry['latitude'] == 34.0525
        assert proof_entry['longitude'] == -118.2440
        assert proof_entry['note'] is None # No note for distance < 1 mile

        # 6. Verify file was saved
        uploaded_filename = os.path.basename(proof_entry['image_path'])
        assert os.path.exists(os.path.join(mock_upload_folder, uploaded_filename))

        # 7. Verify external calls
        assert mock_send_email_called
        assert mock_release_escrow_funds_called

def test_delivery_confirmation_photo_upload_fails_invalid_file_type(client, app, add_user, create_load, monkeypatch):
    """
    Tests delivery confirmation photo upload with an invalid file type.
    """
    monkeypatch.setattr('main.allowed_file', allowed_file_mock)
    monkeypatch.setattr('main.ALLOWED_IMAGE_EXTENSIONS', ALLOWED_IMAGE_EXTENSIONS_MOCK)
    monkeypatch.setattr('main.geocode_address', lambda addr: (34.0522, -118.2437))
    monkeypatch.setattr('main.calculate_distance', lambda lat1, lon1, lat2, lon2: 0.1)

    transporter = add_user("transporter_badfile", "badfile@example.com", "password123")
    load = create_load(transporter['user_id'])

    with client:
        client.post('/login', data={'username': transporter['username'], 'password': transporter['password']})
        with client.session_transaction() as s:
            s['user_id'] = transporter['user_id']
            s['username'] = transporter['username']
            s['role'] = transporter['role']

        data = {
            'load_id': load['load_id'],
            'latitude': '34.0525',
            'longitude': '-118.2440',
            'delivery_proof_pic': (io.BytesIO(b"this is a text file"), 'document.txt') # Invalid file type
        }
        
        response = client.post('/delivery-confirmation', data=data, content_type='multipart/form-data')

        assert response.status_code == 400
        assert b"Invalid file type. Only images (PNG, JPG, WEBP) are allowed." in response.data

def test_delivery_confirmation_photo_upload_fails_missing_gps(client, app, add_user, create_load, monkeypatch):
    """
    Tests delivery confirmation photo upload with missing GPS coordinates.
    """
    monkeypatch.setattr('main.allowed_file', allowed_file_mock)
    monkeypatch.setattr('main.ALLOWED_IMAGE_EXTENSIONS', ALLOWED_IMAGE_EXTENSIONS_MOCK)

    transporter = add_user("transporter_nogps", "nogps@example.com", "password123")
    load = create_load(transporter['user_id'])

    with client:
        client.post('/login', data={'username': transporter['username'], 'password': transporter['password']})
        with client.session_transaction() as s:
            s['user_id'] = transporter['user_id']
            s['username'] = transporter['username']
            s['role'] = transporter['role']

        data = {
            'load_id': load['load_id'],
            'delivery_proof_pic': (io.BytesIO(b"dummy image content"), 'proof.jpg')
            # Missing latitude and longitude
        }
        
        response = client.post('/delivery-confirmation', data=data, content_type='multipart/form-data')

        assert response.status_code == 400
        assert b"GPS coordinates (latitude and longitude) are required for photo uploads to verify location." in response.data

def test_delivery_confirmation_photo_upload_fails_geofence_too_far(client, app, add_user, create_load, monkeypatch):
    """
    Tests delivery confirmation photo upload when location is too far from destination.
    """
    monkeypatch.setattr('main.allowed_file', allowed_file_mock)
    monkeypatch.setattr('main.ALLOWED_IMAGE_EXTENSIONS', ALLOWED_IMAGE_EXTENSIONS_MOCK)
    monkeypatch.setattr('main.geocode_address', lambda addr: (34.0522, -118.2437)) # Los Angeles
    monkeypatch.setattr('main.calculate_distance', lambda lat1, lon1, lat2, lon2: 30.0) # 30 miles away

    transporter = add_user("transporter_far", "far@example.com", "password123")
    load = create_load(transporter['user_id'], delivery="Los Angeles, CA")

    with client:
        client.post('/login', data={'username': transporter['username'], 'password': transporter['password']})
        with client.session_transaction() as s:
            s['user_id'] = transporter['user_id']
            s['username'] = transporter['username']
            s['role'] = transporter['role']

        data = {
            'load_id': load['load_id'],
            'latitude': '34.0525',
            'longitude': '-118.2440',
            'delivery_proof_pic': (io.BytesIO(b"dummy image content"), 'proof.jpg')
        }
        
        response = client.post('/delivery-confirmation', data=data, content_type='multipart/form-data')

        assert response.status_code == 400
        assert b"Delivery photo rejected: Location is 30.0 miles away from the target delivery destination. Please get closer to the destination to upload." in response.data

def test_delivery_confirmation_photo_upload_success_with_note_geofence_warning(client, app, add_user, create_load, mock_upload_folder, monkeypatch):
    """
    Tests successful delivery confirmation photo upload with a note when location is between 1 and 25 miles.
    """
    monkeypatch.setattr('main.allowed_file', allowed_file_mock)
    monkeypatch.setattr('main.ALLOWED_IMAGE_EXTENSIONS', ALLOWED_IMAGE_EXTENSIONS_MOCK)
    monkeypatch.setattr('main.geocode_address', lambda addr: (34.0522, -118.2437)) # Los Angeles
    monkeypatch.setattr('main.calculate_distance', lambda lat1, lon1, lat2, lon2: 5.0) # 5 miles away (between 1 and 25)
    monkeypatch.setattr('main.send_email', lambda *args, **kwargs: True)
    monkeypatch.setattr('payments.release_escrow_funds', lambda *args, **kwargs: True)

    transporter = add_user("transporter_note", "note@example.com", "password123")
    load = create_load(transporter['user_id'], delivery="Los Angeles, CA")

    with client:
        client.post('/login', data={'username': transporter['username'], 'password': transporter['password']})
        with client.session_transaction() as s:
            s['user_id'] = transporter['user_id']
            s['username'] = transporter['username']
            s['role'] = transporter['role']

        data = {
            'load_id': load['load_id'],
            'latitude': '34.0525',
            'longitude': '-118.2440',
            'delivery_proof_pic': (io.BytesIO(b"dummy image content"), 'proof.jpg')
        }
        
        response = client.post('/delivery-confirmation', data=data, content_type='multipart/form-data')

        assert response.status_code == 200
        assert b"Delivery confirmed successfully!" in response.data

        with app.app_context():
            conn = sqlite3.connect(app.config['DATABASE'])
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM delivery_proofs WHERE load_id = ?", (load['load_id'],))
            proof_entry = cursor.fetchone()
            conn.close()

        assert proof_entry is not None
        assert "Note: Proof of delivery was uploaded 5.0 miles away from the destination." in proof_entry['note']

def test_delivery_confirmation_photo_upload_fails_unauthenticated(client, app, create_load, monkeypatch):
    """
    Tests that unauthenticated users cannot upload delivery confirmation photos.
    """
    monkeypatch.setattr('main.allowed_file', allowed_file_mock)
    monkeypatch.setattr('main.ALLOWED_IMAGE_EXTENSIONS', ALLOWED_IMAGE_EXTENSIONS_MOCK)
    monkeypatch.setattr('main.geocode_address', lambda addr: (34.0522, -118.2437))
    monkeypatch.setattr('main.calculate_distance', lambda lat1, lon1, lat2, lon2: 0.1)

    # Create a dummy user and load, but don't log in
    user_id = str(uuid.uuid4())
    load = create_load(user_id)

    data = {
        'load_id': load['load_id'],
        'latitude': '34.0525',
        'longitude': '-118.2440',
        'delivery_proof_pic': (io.BytesIO(b"dummy image content"), 'proof.jpg')
    }
    
    response = client.post('/delivery-confirmation', data=data, content_type='multipart/form-data', follow_redirects=False)

    # Should redirect to login page
    assert response.status_code == 302
    assert '/login' in response.headers['Location']

def test_delivery_confirmation_photo_upload_fails_load_not_found(client, app, add_user, monkeypatch):
    """
    Tests delivery confirmation photo upload fails if load_id is not found.
    """
    monkeypatch.setattr('main.allowed_file', allowed_file_mock)
    monkeypatch.setattr('main.ALLOWED_IMAGE_EXTENSIONS', ALLOWED_IMAGE_EXTENSIONS_MOCK)

    transporter = add_user("transporter_noload", "noload@example.com", "password123")

    with client:
        client.post('/login', data={'username': transporter['username'], 'password': transporter['password']})
        with client.session_transaction() as s:
            s['user_id'] = transporter['user_id']
            s['username'] = transporter['username']
            s['role'] = transporter['role']

        data = {
            'load_id': 'non_existent_load_id',
            'latitude': '34.0525',
            'longitude': '-118.2440',
            'delivery_proof_pic': (io.BytesIO(b"dummy image content"), 'proof.jpg')
        }
        
        response = client.post('/delivery-confirmation', data=data, content_type='multipart/form-data')

        assert response.status_code == 404
        assert b"Load not found." in response.data

def test_delivery_confirmation_fails_no_file_or_signature(client, app, add_user, create_load):
    """
    Tests delivery confirmation fails if neither file nor signature is provided.
    """
    transporter = add_user("transporter_empty", "empty@example.com", "password123")
    load = create_load(transporter['user_id'])

    with client:
        client.post('/login', data={'username': transporter['username'], 'password': transporter['password']})
        with client.session_transaction() as s:
            s['user_id'] = transporter['user_id']
            s['username'] = transporter['username']
            s['role'] = transporter['role']

        data = {
            'load_id': load['load_id'],
            # No 'signature' and no 'delivery_proof_pic'
        }
        
        response = client.post('/delivery-confirmation', data=data, content_type='multipart/form-data')

        assert response.status_code == 400
        assert b"No signature or file provided." in response.data