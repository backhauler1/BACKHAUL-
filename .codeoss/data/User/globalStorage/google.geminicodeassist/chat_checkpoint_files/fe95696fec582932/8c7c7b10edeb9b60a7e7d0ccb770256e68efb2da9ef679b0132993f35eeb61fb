import os
import time
import uuid
import json
import datetime
import sqlite3
from flask import Blueprint, render_template, request, redirect, url_for, session, current_app, Response, send_from_directory
from werkzeug.utils import secure_filename
from itsdangerous import SignatureExpired, BadTimeSignature

# Import shared dependencies from the main application file
from main import (
    DATABASE, get_db, login_required, limiter, 
    ALLOWED_DOC_EXTENSIONS, allowed_file, email_update_serializer, send_email
)

# Create a Blueprint instance for profile routes
profile_bp = Blueprint('profile', __name__)

@profile_bp.route('/delete-account', methods=['POST'])
@login_required
def delete_account():
    """
    Handles user account deletion in compliance with GDPR's Right to Erasure.
    This is a destructive action and will permanently remove the user's data
    and any content they have created.
    """
    user_id = session['user_id']
    
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row # To access columns by name
    cursor = conn.cursor()

    try:
        # --- Step 1: Gather all associated file paths before deletion ---
        files_to_delete = []
        
        # Get user's uploaded document paths from their profile
        cursor.execute("SELECT mc_certificate_path, insurance_path, drivers_license_path FROM users WHERE user_id = ?", (user_id,))
        user_docs = cursor.fetchone()
        if user_docs:
            files_to_delete.extend([path for path in user_docs if path])

        # Get paths for delivery proof and evidence files
        cursor.execute("""
            SELECT dp.image_path FROM delivery_proofs dp
            JOIN loads l ON dp.load_id = l.load_id
            WHERE l.user_id = ? AND dp.image_path IS NOT NULL
        """, (user_id,))
        files_to_delete.extend([row['image_path'] for row in cursor.fetchall()])

        cursor.execute("SELECT file_path FROM dispute_evidence WHERE user_id = ? AND file_path IS NOT NULL", (user_id,))
        files_to_delete.extend([row['file_path'] for row in cursor.fetchall()])

        # --- Step 2: Delete database records in a single transaction ---
        with conn:
            # Get IDs of loads created by the user
            cursor.execute("SELECT load_id FROM loads WHERE user_id = ?", (user_id,))
            load_ids = [row['load_id'] for row in cursor.fetchall()]
            
            # Delete records that directly reference the user
            cursor.execute("DELETE FROM passkeys WHERE user_id = ?", (user_id,))
            cursor.execute("DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?", (user_id, user_id))
            cursor.execute("DELETE FROM reviews WHERE reviewer_id = ? OR reviewee_id = ?", (user_id, user_id))
            cursor.execute("DELETE FROM dispute_evidence WHERE user_id = ?", (user_id,))
            
            # Delete loads and their dependent data
            if load_ids:
                placeholders = ','.join('?' for _ in load_ids)
                cursor.execute(f"DELETE FROM locations WHERE load_id IN ({placeholders})", load_ids)
                cursor.execute(f"DELETE FROM delivery_proofs WHERE load_id IN ({placeholders})", load_ids)
                cursor.execute(f"DELETE FROM matches WHERE load_id IN ({placeholders})", load_ids)
            cursor.execute("DELETE FROM loads WHERE user_id = ?", (user_id,))
            
            # Delete vehicles and any remaining matches associated with them
            cursor.execute("DELETE FROM matches WHERE vehicle_id IN (SELECT vehicle_id FROM vehicles WHERE user_id = ?)", (user_id,))
            cursor.execute("DELETE FROM vehicles WHERE user_id = ?", (user_id,))
            
            # Finally, delete the user record
            cursor.execute("DELETE FROM users WHERE user_id = ?", (user_id,))

        # --- Step 3: Delete physical files from the server ---
        for file_path in set(files_to_delete): # Use set to avoid deleting the same file twice
            if file_path and os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except OSError as e:
                    print(f"Error deleting file {file_path}: {e}")

    except sqlite3.Error as e:
        print(f"Database error during account deletion for user {user_id}: {e}")
        return "An error occurred during account deletion. Please contact support.", 500
    finally:
        conn.close()

    session.clear()
    return redirect(url_for('index'))

@profile_bp.route('/export-my-data', methods=['GET'])
@login_required
def export_my_data():
    """
    Handles user data export in compliance with GDPR's Right of Access.
    Compiles all user-related data into a single JSON file for download.
    """
    user_id = session['user_id']
    
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    data_export = {}

    try:
        # 1. Profile Data (excluding password hash)
        cursor.execute("""
            SELECT user_id, username, email, role, session_version, dot_number, 
                   is_broker_verified, bio, contact_info, mc_certificate_path, 
                   insurance_path, drivers_license_path, is_traveler_verified, 
                   insurance_expiration_date, stripe_account_id, id_verified, 
                   privacy_policy_agreed, agreed_to_policy_version, agreement_timestamp 
            FROM users WHERE user_id = ?
        """, (user_id,))
        profile = cursor.fetchone()
        data_export['profile'] = dict(profile) if profile else {}

        # 2. Loads Posted by User
        cursor.execute("SELECT * FROM loads WHERE user_id = ?", (user_id,))
        loads_posted = [dict(row) for row in cursor.fetchall()]
        data_export['loads_posted'] = loads_posted
        
        # 3. Vehicles Registered by User
        cursor.execute("SELECT * FROM vehicles WHERE user_id = ?", (user_id,))
        data_export['vehicles_registered'] = [dict(row) for row in cursor.fetchall()]

        # 4. Messages Sent or Received
        cursor.execute("SELECT * FROM messages WHERE sender_id = ? OR receiver_id = ?", (user_id, user_id))
        data_export['messages'] = [dict(row) for row in cursor.fetchall()]

        # 5. Reviews Given or Received
        cursor.execute("SELECT * FROM reviews WHERE reviewer_id = ? OR reviewee_id = ?", (user_id, user_id))
        data_export['reviews'] = [dict(row) for row in cursor.fetchall()]

        # 6. Passkeys (excluding public key blob for security/size)
        cursor.execute("SELECT credential_id, sign_count, transports FROM passkeys WHERE user_id = ?", (user_id,))
        data_export['passkeys'] = [dict(row) for row in cursor.fetchall()]

        # 7. Dispute Evidence submitted by the user
        cursor.execute("SELECT * FROM dispute_evidence WHERE user_id = ?", (user_id,))
        data_export['dispute_evidence'] = [dict(row) for row in cursor.fetchall()]

    except sqlite3.Error as e:
        print(f"Database error during data export for user {user_id}: {e}")
        return "An error occurred while exporting your data. Please contact support.", 500
    finally:
        conn.close()

    return Response(
        json.dumps(data_export, indent=4, default=str),
        mimetype='application/json',
        headers={'Content-Disposition': 'attachment;filename=my_data.json'}
    )

@profile_bp.route('/request-email-change', methods=['POST'])
@login_required
@limiter.limit("3 per hour")
def request_email_change():
    """Initiates a secure email change by sending a verification link to the new address."""
    new_email = request.form.get('new_email')
    if not new_email:
        return "New email is required.", 400

    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    cursor.execute("SELECT user_id FROM users WHERE email = ?", (new_email,))
    if cursor.fetchone():
        conn.close()
        return "That email address is already in use by another account.", 409
    conn.close()

    token = email_update_serializer.dumps({'user_id': user_id, 'new_email': new_email})
    verify_link = url_for('profile.confirm_email_change', token=token, _external=True)

    text_content = f"Hello,\n\nPlease click the link below to verify and update your email address. This link is valid for 1 hour.\n{verify_link}\n\nIf you did not request this change, please ignore this email."
    
    if send_email(new_email, "Verify Your New Email Address", text_content):
        return "A verification link has been sent to your new email address. Please check your inbox.", 200
    else:
        return "Failed to send verification email. Please try again later.", 500

@profile_bp.route('/confirm-email-change/<token>')
def confirm_email_change(token):
    """Verifies the token and permanently updates the user's email in the database."""
    try:
        data = email_update_serializer.loads(token, max_age=3600)
        user_id = data.get('user_id')
        new_email = data.get('new_email')
    except (SignatureExpired, BadTimeSignature):
        return '<h1>Invalid or Expired Link</h1><p>The email verification link has expired or is invalid.</p>', 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET email = ? WHERE user_id = ?", (new_email, user_id))
    conn.commit()
    conn.close()

    return redirect(url_for('profile.edit_profile'))

@profile_bp.route('/delete-document/<doc_type>', methods=['POST'])
@login_required
def delete_document(doc_type):
    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("SELECT mc_certificate_path, insurance_path, drivers_license_path FROM users WHERE user_id = ?", (user_id,))
    user_row = cursor.fetchone()
    
    if not user_row:
        conn.close()
        return "User not found", 404

    column_to_clear = None
    file_path = None

    if doc_type == 'mc_cert':
        column_to_clear = 'mc_certificate_path'
        file_path = user_row['mc_certificate_path']
    elif doc_type == 'insurance':
        column_to_clear = 'insurance_path'
        file_path = user_row['insurance_path']
    elif doc_type == 'license':
        column_to_clear = 'drivers_license_path'
        file_path = user_row['drivers_license_path']

    if column_to_clear:
        if file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception as e:
                print(f"Failed to delete file {file_path}: {e}")

        cursor.execute(f"UPDATE users SET {column_to_clear} = NULL WHERE user_id = ?", (user_id,))
        
        if doc_type == 'mc_cert':
            cursor.execute("UPDATE users SET is_broker_verified = 0 WHERE user_id = ?", (user_id,))
            
        conn.commit()

    conn.close()
    return redirect(url_for('profile.edit_profile'))

@profile_bp.route('/edit-profile', methods=['GET', 'POST'])
@login_required
def edit_profile():
    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    if request.method == 'POST':
        bio = request.form.get('bio')
        contact_info = request.form.get('contact_info')
        dot_number = request.form.get('dot_number')
        insurance_expiration_date = request.form.get('insurance_expiration_date')
        
        mc_cert_file = request.files.get('mc_certificate')
        insurance_file = request.files.get('insurance_doc')
        license_file = request.files.get('drivers_license')
        
        mc_cert_path = None
        insurance_path = None
        license_path = None

        if mc_cert_file and mc_cert_file.filename != '':
            if not allowed_file(mc_cert_file.filename, ALLOWED_DOC_EXTENSIONS):
                return "Invalid file type for MC Certificate.", 400
            filename = secure_filename(mc_cert_file.filename)
            mc_cert_dir = os.path.join(current_app.config['UPLOAD_FOLDER'], 'mc_certs')
            os.makedirs(mc_cert_dir, exist_ok=True)
            unique_filename = f"mc_cert_{user_id}_{uuid.uuid4().hex[:8]}_{filename}"
            save_path = os.path.join(mc_cert_dir, unique_filename)
            mc_cert_file.save(save_path)
            mc_cert_path = save_path

        if insurance_file and insurance_file.filename != '':
            if not allowed_file(insurance_file.filename, ALLOWED_DOC_EXTENSIONS):
                return "Invalid file type for Insurance Document.", 400
            filename = secure_filename(insurance_file.filename)
            ins_dir = os.path.join(current_app.config['UPLOAD_FOLDER'], 'insurance_docs')
            os.makedirs(ins_dir, exist_ok=True)
            unique_filename = f"ins_{user_id}_{uuid.uuid4().hex[:8]}_{filename}"
            save_path = os.path.join(ins_dir, unique_filename)
            insurance_file.save(save_path)
            insurance_path = save_path

        if license_file and license_file.filename != '':
            if not allowed_file(license_file.filename, ALLOWED_DOC_EXTENSIONS):
                return "Invalid file type for Driver's License.", 400
            filename = secure_filename(license_file.filename)
            lic_dir = os.path.join(current_app.config['UPLOAD_FOLDER'], 'driver_licenses')
            os.makedirs(lic_dir, exist_ok=True)
            unique_filename = f"lic_{user_id}_{uuid.uuid4().hex[:8]}_{filename}"
            save_path = os.path.join(lic_dir, unique_filename)
            license_file.save(save_path)
            license_path = save_path

        cursor.execute("SELECT dot_number, mc_certificate_path, insurance_path, drivers_license_path, id_verified FROM users WHERE user_id = ?", (user_id,))
        user_row = cursor.fetchone()
        
        if user_row and user_row['dot_number'] != dot_number:
            cursor.execute("UPDATE users SET is_broker_verified = 0 WHERE user_id = ?", (user_id,))
            
        final_mc_cert_path = mc_cert_path if mc_cert_path else (user_row['mc_certificate_path'] if user_row else None)
        final_insurance_path = insurance_path if insurance_path else (user_row['insurance_path'] if user_row else None)
        final_license_path = license_path if license_path else (user_row['drivers_license_path'] if user_row else None)
        id_verified = user_row['id_verified'] if user_row else 0

        is_traveler_verified = 0
        insurance_is_valid = False
        if insurance_expiration_date:
            try:
                exp_date = datetime.datetime.strptime(insurance_expiration_date, '%Y-%m-%d').date()
                if exp_date > datetime.date.today():
                    insurance_is_valid = True
            except (ValueError, TypeError):
                pass 

        if id_verified and final_insurance_path and final_license_path and insurance_is_valid:
            is_traveler_verified = 1

        cursor.execute("""
            UPDATE users 
            SET bio = ?, contact_info = ?, dot_number = ?, mc_certificate_path = ?, insurance_path = ?, drivers_license_path = ?, insurance_expiration_date = ?, is_traveler_verified = ?
            WHERE user_id = ?
        """, (bio, contact_info, dot_number, final_mc_cert_path, final_insurance_path, final_license_path, insurance_expiration_date, is_traveler_verified, user_id))
        
        conn.commit()
        conn.close()
        return redirect(url_for('profile.profile', user_id=user_id))

    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    conn.close()
    
    return render_template('edit_profile.html', user=user)

@profile_bp.route('/profile/<user_id>')
def profile(user_id):
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    if not user:
        return "User not found", 404

    cursor.execute("""
        SELECT r.rating, r.comment, r.timestamp, u.username as reviewer_name, r.reviewer_id, l.description as load_description
        FROM reviews r 
        JOIN users u ON r.reviewer_id = u.user_id
        LEFT JOIN matches ma ON r.match_id = ma.match_id
        LEFT JOIN loads l ON ma.load_id = l.load_id
        WHERE r.reviewee_id = ? 
        ORDER BY r.timestamp DESC
    """, (user_id,))
    reviews = cursor.fetchall()
    
    cursor.execute("SELECT AVG(rating) as avg_rating, COUNT(rating) as rating_count FROM reviews WHERE reviewee_id = ?", (user_id,))
    rating_stats = cursor.fetchone()
    
    cursor.execute("SELECT * FROM loads WHERE user_id = ? AND is_flagged = 0 ORDER BY timestamp DESC", (user_id,))
    loads = cursor.fetchall()
    cursor.execute("SELECT * FROM vehicles WHERE user_id = ? ORDER BY timestamp DESC", (user_id,))
    trucks = cursor.fetchall()
    
    completed_matches = []
    asap_loads = []
    
    return render_template('profile.html', 
                           user=user, 
                           reviews=reviews, 
                           rating_stats=rating_stats,
                           loads=loads,
                           trucks=trucks,
                           completed_matches=completed_matches,
                           asap_loads=asap_loads)

@profile_bp.route('/document/<user_id>/<doc_type>')
@login_required
def serve_user_doc(user_id, doc_type):
    """Serves user profile documents securely to logged-in users."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT mc_certificate_path, insurance_path, drivers_license_path FROM users WHERE user_id = ?", (user_id,))
    user_row = cursor.fetchone()
    conn.close()

    if not user_row:
        return "User not found", 404

    path = None
    if doc_type == 'mc_cert':
        path = user_row['mc_certificate_path']
    elif doc_type == 'insurance':
        path = user_row['insurance_path']
    elif doc_type == 'license':
        path = user_row['drivers_license_path']

    if not path or not os.path.exists(path):
        return "Document not found", 404

    directory, filename = os.path.split(path)
    return send_from_directory(directory, filename)