import sqlite3
from main import DATABASE
from werkzeug.security import generate_password_hash
from flask import session

def test_resend_verification_page_loads(client):
    """
    GIVEN a Flask application configured for testing
    WHEN the '/resend-verification' page is requested (GET)
    THEN check that the response is valid and contains the correct content.
    """
    # We are assuming the URL for the 'resend_verification' route is '/resend-verification'.
    # If your auth blueprint has a prefix (e.g., '/auth'), you would use '/auth/resend-verification'.
    response = client.get('/resend-verification')

    # Assert that the page loads successfully (status code 200 OK)
    assert response.status_code == 200

    # Assert that key phrases from the template are in the response data.
    # This confirms the correct template was rendered.
    # We use `b''` to denote byte strings, as response.data is in bytes.
    assert b"Resend Verification Link" in response.data
    assert b"Enter your registered email" in response.data
    assert b"Resend Verification Email" in response.data # The button text

def test_resend_verification_post(client):
    """
    GIVEN a Flask application configured for testing
    WHEN the '/resend-verification' page receives a POST request with an email
    THEN check that it returns a 200 OK and acknowledges the request.
    """
    response = client.post('/resend-verification', data={'email': 'test@example.com'})

    assert response.status_code == 200
    # Your success template displays the email that was submitted, so we can check for it
    assert b"test@example.com" in response.data

def test_resend_verification_existing_user(client, app, monkeypatch):
    """
    GIVEN a database with an existing unverified user
    WHEN the '/resend-verification' page receives a POST request with their email
    THEN check that it succeeds and an email would be sent.
    """
    # 1. Mock the send_email function so we don't send real emails during tests!
    email_sent = False
    def mock_send_email(to_email, subject, text_content, html_content=None, cc_email=None, bcc_email=None):
        nonlocal email_sent
        email_sent = True
        return True
        
    # Replace the send_email function imported in auth.py with our mock
    monkeypatch.setattr('auth.send_email', mock_send_email)

    # 2. Insert a dummy user directly into the temporary test database
    with app.app_context():
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (user_id, username, email, password_hash, role, is_email_verified) VALUES (?, ?, ?, ?, ?, ?)",
            ("test-id-123", "testuser", "existing@example.com", "fakehash", "shipper", 0)
        )
        conn.commit()
        conn.close()

    # 3. Make the POST request with the existing user's email
    response = client.post('/resend-verification', data={'email': 'existing@example.com'})

    # 4. Assert the response and that our mocked email function was called
    assert response.status_code == 200
    assert b"existing@example.com" in response.data
    assert email_sent is True

def test_login_with_verified_user(client, app):
    """
    GIVEN a database with an existing, verified user
    WHEN a POST request is made to /login with correct credentials
    THEN check that the user is logged in and redirected to the dashboard.
    """
    # 1. Create a verified user in the test database with a known password
    password = "a-S3cure-P@ssword!"
    password_hash = generate_password_hash(password)

    with app.app_context():
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (user_id, username, email, password_hash, role, is_email_verified) VALUES (?, ?, ?, ?, ?, ?)",
            ("verified-user-id", "verifieduser", "verified@example.com", password_hash, "shipper", 1)
        )
        conn.commit()
        conn.close()

    # 2. Use a `with` block to maintain the session across requests
    with client:
        # Make the POST request to log in and follow the redirect
        login_response = client.post('/login', data={
            'username': 'verifieduser',
            'password': password
        }, follow_redirects=True)

        # 3. Assert the final page is the dashboard
        assert login_response.status_code == 200
        assert b"Dashboard" in login_response.data
        # 4. Assert that the session was set correctly
        assert session['user_id'] == 'verified-user-id'
        assert session['username'] == 'verifieduser'

def test_login_unverified_user_fails(client, app):
    """
    GIVEN a database with an unverified user
    WHEN a POST request is made to /login with their credentials
    THEN check that the login fails with a 403 Forbidden error.
    """
    # Create a user with is_email_verified = 0
    with app.app_context():
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (user_id, username, email, password_hash, role, is_email_verified) VALUES (?, ?, ?, ?, ?, ?)",
            ("unverified-user-id", "unverified", "unverified@example.com", generate_password_hash("pw"), "shipper", 0)
        )
        conn.commit()
        conn.close()

    response = client.post('/login', data={'username': 'unverified', 'password': 'pw'})

    assert response.status_code == 403
    assert b"Your email address is not verified" in response.data

def test_login_wrong_password_fails(client):
    """
    GIVEN a user exists
    WHEN a POST request is made to /login with the wrong password
    THEN check that the login fails with a 401 Unauthorized error.
    """
    # We can use the user created in the test_login_with_verified_user test,
    # but we don't need to create a new one. We just need to attempt a login.
    response = client.post('/login', data={'username': 'verifieduser', 'password': 'WrongPassword!'})

    assert response.status_code == 401
    assert b"Invalid username or password" in response.data