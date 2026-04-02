from flask import Blueprint, render_template, request, redirect, url_for, flash, session

# Create a Blueprint instance for authentication routes
auth_bp = Blueprint('auth', __name__)

@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        # TODO: Paste your existing registration logic from app.py here
        # e.g., username = request.form.get('username')
        pass
        
    return render_template('register.html')

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        # TODO: Paste your existing login logic from app.py here
        # e.g., email = request.form.get('email')
        pass
        
    return render_template('login.html')

@auth_bp.route('/logout')
def logout():
    # TODO: Paste your existing logout logic here
    session.clear()
    # flash('You have been logged out.', 'info')
    return redirect(url_for('index'))