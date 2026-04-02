import sqlite3
from main import DATABASE
import re
from werkzeug.security import generate_password_hash
from flask import session
from itsdangerous import SignatureExpired

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

def test_resend_verification_existing_user(client, monkeypatch, add_user):
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

    # 2. Create an unverified user using our new factory fixture
    user = add_user(
        username="testuser",
        email="existing@example.com",
        password="password123",
        is_verified=False
    )

    # 3. Make the POST request with the existing user's email
    response = client.post('/resend-verification', data={'email': user['email']})

    # 4. Assert the response and that our mocked email function was called
    assert response.status_code == 200
    assert user['email'].encode() in response.data
    assert email_sent is True

def test_login_with_verified_user(client, add_user):
    """
    GIVEN a database with an existing, verified user
    WHEN a POST request is made to /login with correct credentials
    THEN check that the user is logged in and redirected to the dashboard.
    """
    # 1. Create a verified user using the factory fixture
    user = add_user(
        username="verifieduser",
        email="verified@example.com",
        password="a-S3cure-P@ssword!",
        is_verified=True
    )

    # 2. Use a `with` block to maintain the session across requests
    with client:
        # Make the POST request to log in and follow the redirect
        login_response = client.post('/login', data={
            'username': user['username'],
            'password': user['password']
        }, follow_redirects=True)

        # 3. Assert the final page is the dashboard
        assert login_response.status_code == 200
        assert b"Dashboard" in login_response.data
        # 4. Assert that the session was set correctly
        assert session['user_id'] == user['user_id']
        assert session['username'] == user['username']

def test_login_unverified_user_fails(client, add_user):
    """
    GIVEN a database with an unverified user
    WHEN a POST request is made to /login with their credentials
    THEN check that the login fails with a 403 Forbidden error.
    """
    # 1. Create an unverified user
    user = add_user(
        username="unverified",
        email="unverified@example.com",
        password="password123",
        is_verified=False
    )

    # 2. Attempt to log in
    response = client.post('/login', data={'username': user['username'], 'password': user['password']})

    # 3. Assert failure
    assert response.status_code == 403
    assert b"Your email address is not verified" in response.data

def test_login_wrong_password_fails(client, add_user):
    """
    GIVEN a user exists
    WHEN a POST request is made to /login with the wrong password
    THEN check that the login fails with a 401 Unauthorized error.
    """
    # 1. Create a user so the test is independent
    user = add_user(
        username="verifieduser",
        email="verified@example.com",
        password="a-S3cure-P@ssword!",
        is_verified=True
    )

    # 2. Attempt to log in with the wrong password
    response = client.post('/login', data={'username': user['username'], 'password': 'WrongPassword!'})

    # 3. Assert failure
    assert response.status_code == 401
    assert b"Invalid username or password" in response.data

def test_registration_and_verification_flow(client, monkeypatch, app):
    """
    GIVEN a new user's registration details
    WHEN they submit the registration form, receive an email, and click the verification link
    THEN a new user is created, marked as verified, and can successfully log in.
    """
    # 1. Mock the send_email function to capture the verification link
    sent_email_args = {}
    def mock_send_email(to_email, subject, text_content, **kwargs):
        nonlocal sent_email_args
        sent_email_args['to'] = to_email
        sent_email_args['subject'] = subject
        sent_email_args['text'] = text_content
        return True
    
    monkeypatch.setattr('auth.send_email', mock_send_email)

    # 2. Make a POST request to the registration endpoint
    registration_data = {
        'username': 'new_user_to_verify',
        'email': 'new_verify@example.com',
        'password': 'a-Very-Strong-P@ssword1!',
        'role': 'shipper',
        'privacy_policy': 'on'
    }
    reg_response = client.post('/register', data=registration_data)

    # 3. Assert that the registration page was successful
    assert reg_response.status_code == 200
    assert b"Registration Successful!" in reg_response.data

    # 4. Check the database to confirm the user was created but is NOT verified
    with app.app_context():
        conn = sqlite3.connect(DATABASE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT user_id, is_email_verified FROM users WHERE username = ?", (registration_data['username'],))
        user_row = cursor.fetchone()
        conn.close()
    
    assert user_row is not None
    assert user_row['is_email_verified'] == 0
    user_id = user_row['user_id']

    # 5. Extract the verification token from the mocked email's body
    assert 'text' in sent_email_args, "Email was not sent"
    email_body = sent_email_args['text']
    match = re.search(r'/verify-email/([^\s]+)', email_body)
    assert match is not None, "Verification link not found in email body"
    token = match.group(1)

    # 6. "Click" the verification link, following the redirect
    verify_response = client.get(f'/verify-email/{token}', follow_redirects=True)
    
    # 7. Assert that we landed on the login page
    assert verify_response.status_code == 200
    assert b"Login" in verify_response.data

    # 8. Check the database again to confirm the user is now verified
    with app.app_context():
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("SELECT is_email_verified FROM users WHERE user_id = ?", (user_id,))
        is_verified = cursor.fetchone()[0]
        conn.close()
    assert is_verified == 1

def test_register_with_existing_username_fails(client, add_user):
    """
    GIVEN a user already exists in the database
    WHEN a new user tries to register with the same username
    THEN the registration fails with a 409 Conflict error.
    """
    # 1. Create an initial user
    add_user(username="existinguser", email="initial@example.com", password="pw")

    # 2. Attempt to register with the same username
    response = client.post('/register', data={'username': 'existinguser', 'email': 'new@example.com', 'password': 'StrongPassword123!', 'role': 'shipper', 'privacy_policy': 'on'})

    # 3. Assert failure
    assert response.status_code == 409
    assert b"Username already exists" in response.data

def test_expired_verification_link(client, monkeypatch):
    """
    GIVEN a verification token
    WHEN the token is expired and the verify-email route is requested
    THEN check that it fails with a 400 error.
    """
    # 1. Mock the loads function to raise SignatureExpired, simulating the passage of time
    def mock_loads(token, max_age=None):
        raise SignatureExpired("Token expired")
        
    # Replace the serializer's loads method in auth.py
    monkeypatch.setattr('auth.verification_serializer.loads', mock_loads)
    
    # 2. Make a GET request to the verification endpoint with a dummy token
    response = client.get('/verify-email/dummy-expired-token')
    
    # 3. Assert that it returns a 400 error and the expected text
    assert response.status_code == 400
    assert b"Invalid or Expired Link" in response.data

def test_dashboard_redirects_for_unauthenticated_user(client):
    """
    GIVEN a Flask application
    WHEN the '/dashboard' page is requested by an unauthenticated user
    THEN check that the user is redirected to the login page.
    """
    response = client.get('/dashboard', follow_redirects=False)

    # Assert that the response is a redirect (status code 302)
    assert response.status_code == 302
    # Assert that the redirect location is the login page
    assert '/login' in response.location

def test_dashboard_loads_for_authenticated_user(client, add_user):
    """
    GIVEN a verified user who is logged in
    WHEN the '/dashboard' page is requested
    THEN check that the page loads successfully and contains user-specific content.
    """
    # 1. Create a verified user
    user = add_user(
        username="dashboarduser",
        email="dashboard@example.com",
        password="a-S3cure-P@ssword!",
        is_verified=True
    )

    # 2. Log the user in to establish a session
    with client:
        client.post('/login', data={'username': user['username'], 'password': user['password']})
        # 3. Now, with the session active, request the dashboard
        response = client.get('/dashboard')

    # 4. Assert the page loaded successfully and contains expected content
    assert response.status_code == 200
    assert b"Dashboard" in response.data
    assert user['username'].encode() in response.data

def test_logout_functionality(client, add_user):
    """
    GIVEN a user is logged in
    WHEN they access the /logout endpoint
    THEN their session is cleared and they can no longer access protected routes.
    """
    # 1. Create and log in a user
    user = add_user(username="logoutuser", email="logout@example.com", password="pw")

    with client:
        # Log in and confirm the session is active by checking the session object
        client.post('/login', data={'username': user['username'], 'password': user['password']})
        assert 'user_id' in session, "Session was not created on login"

        # 2. Access the logout route. The route redirects, so we follow it.
        logout_response = client.get('/logout', follow_redirects=True)

        # 3. Assert that we landed on the homepage successfully
        assert logout_response.status_code == 200
        # The index route in main.py renders index.html, which should contain the app name.
        assert b"GottaBackhaul" in logout_response.data

        # 4. Verify the session is truly gone by attempting to access a protected route
        dashboard_after_logout = client.get('/dashboard', follow_redirects=False)
        assert dashboard_after_logout.status_code == 302
        assert '/login' in dashboard_after_logout.location