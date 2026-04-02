import pytest
import tempfile
import os

# Import the app and init_db function from your main.py
from main import app as flask_app, init_db

@pytest.fixture
def app(monkeypatch):
    """
    A test fixture that sets up the Flask app for testing for each test function.
    - It uses a temporary, separate database.
    - It configures the app for TESTING mode.
    """
    # Create a temporary file for the SQLite database, which returns a file
    # descriptor and a path.
    db_fd, db_path = tempfile.mkstemp(suffix='.db')

    # Use pytest's monkeypatch to replace the DATABASE path in your main.py.
    # This is crucial to ensure tests don't touch your development database.
    monkeypatch.setattr('main.DATABASE', db_path)

    # Apply test-specific configuration
    flask_app.config.update({
        "TESTING": True,
        "SECRET_KEY": "test-secret-key",
        "WTF_CSRF_ENABLED": False,  # Disable CSRF forms in tests for simplicity
        "SERVER_NAME": "localhost.localdomain" # Required for url_for to work in tests
    })

    # The app_context is needed for init_db and other Flask operations
    with flask_app.app_context():
        init_db() # Initialize the temporary database with the schema

    yield flask_app

    # Teardown: close the file descriptor and remove the temp database after the test
    os.close(db_fd)
    os.unlink(db_path)

@pytest.fixture
def client(app):
    """A test client for the app. This is what you'll use to make requests."""
    return app.test_client()