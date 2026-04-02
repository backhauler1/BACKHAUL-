import pytest
from datetime import datetime, timedelta
from flask import Flask

# We are re-defining the filter function here for test isolation.
# In a real application, you would import this from where it's defined (e.g., from app import datetimeformat).
def datetimeformat(value, full=False):
    """
    Formats a datetime object into a user-friendly string.
    - Default: Relative time (e.g., "5 minutes ago", "Yesterday at 3:30 PM").
    - full=True: Full absolute time (e.g., "Monday, August 12, 2024 at 03:45:30 PM").
    """
    if not isinstance(value, datetime):
        return value

    # The format for the 'title' attribute on hover.
    if full:
        # e.g., "Monday, August 12, 2024 at 03:45:30 PM"
        return value.strftime('%A, %B %d, %Y at %I:%M %p')

    # The format for the main display.
    now = datetime.utcnow()
    diff = now - value
    
    seconds = diff.total_seconds()
    days = diff.days

    if days < 0:
        # For future dates, though unlikely in this context.
        return value.strftime('%b %d, %Y')

    if days == 0:  # Today
        if seconds < 10:
            return "just now"
        if seconds < 60:
            return f"{int(seconds)} seconds ago"
        if seconds < 3600:
            minutes = int(seconds / 60)
            return f"{minutes} minute{'s' if minutes > 1 else ''} ago"
        hours = int(seconds / 3600)
        return f"{hours} hour{'s' if hours > 1 else ''} ago"

    if days == 1:
        # .lstrip('0') is a cross-platform way to handle leading zeros on hours.
        return f"Yesterday at {value.strftime('%I:%M %p').lstrip('0')}"

    if days < 7:
        return f"{days} days ago"

    # Older than a week
    return value.strftime('%b %d, %Y')


@pytest.fixture
def app():
    """Create a Flask app instance for testing."""
    app = Flask(__name__)
    app.jinja_env.filters['datetimeformat'] = datetimeformat
    return app


def test_datetimeformat_just_now():
    past_time = datetime.utcnow() - timedelta(seconds=5)
    assert datetimeformat(past_time) == "just now"

def test_datetimeformat_seconds_ago():
    past_time = datetime.utcnow() - timedelta(seconds=30)
    assert datetimeformat(past_time) == "30 seconds ago"

def test_datetimeformat_minute_ago():
    past_time = datetime.utcnow() - timedelta(minutes=1, seconds=30)
    assert datetimeformat(past_time) == "1 minute ago"

def test_datetimeformat_minutes_ago():
    past_time = datetime.utcnow() - timedelta(minutes=5)
    assert datetimeformat(past_time) == "5 minutes ago"

def test_datetimeformat_hour_ago():
    past_time = datetime.utcnow() - timedelta(hours=1, minutes=5)
    assert datetimeformat(past_time) == "1 hour ago"

def test_datetimeformat_hours_ago():
    past_time = datetime.utcnow() - timedelta(hours=3)
    assert datetimeformat(past_time) == "3 hours ago"

def test_datetimeformat_yesterday():
    past_time = datetime.utcnow() - timedelta(days=1)
    expected_time = past_time.strftime('%I:%M %p').lstrip('0')
    assert datetimeformat(past_time) == f"Yesterday at {expected_time}"

def test_datetimeformat_days_ago():
    past_time = datetime.utcnow() - timedelta(days=4)
    assert datetimeformat(past_time) == "4 days ago"

def test_datetimeformat_older_than_a_week():
    past_time = datetime.utcnow() - timedelta(days=10)
    assert datetimeformat(past_time) == past_time.strftime('%b %d, %Y')

def test_datetimeformat_full_format():
    test_date = datetime(2023, 10, 27, 15, 45, 30)
    expected = "Friday, October 27, 2023 at 03:45 PM"
    assert datetimeformat(test_date, full=True) == expected

def test_datetimeformat_non_datetime_input():
    assert datetimeformat("not a date") == "not a date"
    assert datetimeformat(None) is None

def test_datetimeformat_in_template(app):
    with app.test_request_context():
        template = app.jinja_env.from_string("{{ my_date | datetimeformat }}")
        past_time = datetime.utcnow() - timedelta(minutes=10)
        rendered = template.render(my_date=past_time)
        assert rendered == "10 minutes ago"

def test_datetimeformat_full_in_template(app):
    with app.test_request_context():
        template = app.jinja_env.from_string("{{ my_date | datetimeformat(full=true) }}")
        test_date = datetime(2023, 10, 27, 15, 45, 30)
        rendered = template.render(my_date=test_date)
        assert rendered == "Friday, October 27, 2023 at 03:45 PM"