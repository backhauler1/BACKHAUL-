import os
import smtplib
from email.mime.text import MIMEText
from datetime import date, timedelta
from sqlalchemy import create_engine, Column, Integer, String, Date, select
from sqlalchemy.orm import sessionmaker, declarative_base

# --- Configuration ---
# Construct absolute path to the database to make the script runnable from anywhere (e.g., cron)
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DATABASE_PATH = os.path.join(BASE_DIR, 'trucking.db')
# It's best practice to load these from environment variables or a config file.
DATABASE_URI = os.getenv('DATABASE_URL', 'sqlite:///../instance/app.db')
DATABASE_URI = os.getenv('DATABASE_URL', f'sqlite:///{DATABASE_PATH}')
SMTP_SERVER = os.getenv('SMTP_SERVER', 'smtp.example.com')
SMTP_PORT = int(os.getenv('SMTP_PORT', 587))
SMTP_USER = os.getenv('SMTP_USER', 'user@example.com')
SMTP_PASSWORD = os.getenv('SMTP_PASSWORD', 'password')
SENDER_EMAIL = os.getenv('SENDER_EMAIL', 'noreply@backhaul.com')

# --- Database Setup (assuming SQLAlchemy) ---
# In a real app, you would import your existing models and db session setup.
# This is a placeholder based on your application's context.
# NOTE: This script uses SQLAlchemy, while main.py uses the standard sqlite3 library.
# The model below is a placeholder and may need to be adjusted to match the 'users' table schema in 'trucking.db'.
Base = declarative_base()

class User(Base):
    __tablename__ = 'user'
    user_id = Column(Integer, primary_key=True)
    username = Column(String(80), unique=True, nullable=False)
    email = Column(String(120), unique=True, nullable=False)
    insurance_expiration_date = Column(Date)
    # ... other fields from your model

engine = create_engine(DATABASE_URI)
Session = sessionmaker(bind=engine)

def find_users_with_expiring_insurance(days_away: int):
    """
    Finds users whose insurance is expiring in exactly `days_away` days.
    """
    session = Session()
    try:
        target_date = date.today() + timedelta(days=days_away)
        print(f"Checking for insurance expiring on: {target_date.isoformat()}")

        stmt = select(User).where(User.insurance_expiration_date == target_date)
        users = session.scalars(stmt).all()
        
        return users
    finally:
        session.close()

def send_warning_email(user: User):
    """
    Sends an insurance expiration warning email to a user.
    """
    # You can make this an HTML email for better formatting
    subject = "Your BACKHAUL Insurance is Expiring Soon!"
    body = f"""
    Hi {user.username},

    This is a friendly reminder that your insurance policy on file with BACKHAUL is set to expire in 7 days, on {user.insurance_expiration_date.strftime('%B %d, %Y')}.

    To avoid any interruption to your "Verified Traveler" status and to remain eligible for jobs that require insurance, please log in to your dashboard and upload your new policy documents as soon as possible.

    You can update your profile here: [Link to your app's edit profile page, e.g., https://your-app.com/edit-profile]

    Thank you,
    The BACKHAUL Team
    """

    msg = MIMEText(body)
    msg['Subject'] = subject
    msg['From'] = f"BACKHAUL <{SENDER_EMAIL}>"
    msg['To'] = user.email

    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()  # Secure the connection
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(SENDER_EMAIL, [user.email], msg.as_string())
            print(f"Successfully sent warning email to {user.email}")
    except Exception as e:
        print(f"Failed to send email to {user.email}: {e}")

def main():
    """
    Main function to run the daily check.
    """
    print("Starting daily insurance expiration check...")
    
    # We want to warn users 7 days in advance.
    expiring_soon_users = find_users_with_expiring_insurance(days_away=7)

    if not expiring_soon_users:
        print("No users with insurance expiring in 7 days.")
    else:
        print(f"Found {len(expiring_soon_users)} user(s) with insurance expiring soon.")
        for user in expiring_soon_users:
            send_warning_email(user)

    print("Finished daily insurance expiration check.")

if __name__ == "__main__":
    main()