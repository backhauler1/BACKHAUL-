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