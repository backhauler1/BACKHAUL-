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