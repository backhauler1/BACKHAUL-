import sqlite3
from main import DATABASE

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