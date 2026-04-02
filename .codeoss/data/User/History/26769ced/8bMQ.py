import os
import time
import sqlite3
from flask import Blueprint, request, jsonify, render_template, redirect, url_for, session, send_from_directory, current_app
from werkzeug.utils import secure_filename

# Delay imports to avoid circular dependencies
from main import (
    get_db, login_required,
    ALLOWED_IMAGE_EXTENSIONS, allowed_file,
    calculate_distance, geocode_address, send_email
)
from payments import release_escrow_funds, notify_dispute_created

tracking_bp = Blueprint('tracking', __name__)

def notify_shipper_delivery(load_id):
    """Sends an email to the shipper notifying them that delivery proof has been uploaded."""
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT u.email, l.description 
        FROM loads l
        JOIN users u ON l.user_id = u.user_id
        WHERE l.load_id = ?
    """, (load_id,))
    
    row = cursor.fetchone()
    
    if row and row['email']:
        proof_link = url_for('tracking.view_delivery_proof', load_id=load_id, _external=True)
        text_content = f"Hello,\n\nThe transporter has uploaded delivery proof for your load: '{row['description']}'.\n\nYou can view the photo and verify the GPS location by clicking the link below:\n{proof_link}\n\nThank you for using GottaBackhaul!"
        send_email(row['email'], f"Delivery Proof Uploaded: {row['description']}", text_content)

@tracking_bp.route('/delivery-confirmation', methods=['POST'])
def delivery_confirmation():
    """
    Handles delivery confirmation via a text signature or an uploaded image.
    Expects a 'load_id' in the form data to identify the delivery.
    For signatures, expects a 'signature' field.
    For pictures, expects a file in the 'delivery_proof_pic' field.
    """
    load_id = request.form.get('load_id')
    if not load_id:
        return jsonify({"error": "Missing 'load_id' in form data."}), 400

    conn = get_db()
    cursor = conn.cursor()

    # --- Option 1: Handle text signature ---
    signature = request.form.get('signature')
    if signature:
        cursor.execute(
            "INSERT INTO delivery_proofs (load_id, signature, timestamp) VALUES (?, ?, ?)",
            (load_id, signature, time.time())
        )
        conn.commit()
        release_escrow_funds(load_id, cursor)
        notify_shipper_delivery(load_id)
        print(f"Received signature for load '{load_id}': {signature}")
        return f"Signature received for load {load_id}!"

    # --- Option 2: Handle image upload ---
    if 'delivery_proof_pic' not in request.files:
        return 'No file part in the request. Please use the "delivery_proof_pic" field.', 400
    
    file = request.files['delivery_proof_pic']

    if file.filename == '':
        return 'No file selected for upload.', 400
        
    if not allowed_file(file.filename, ALLOWED_IMAGE_EXTENSIONS):
        return 'Invalid file type. Only images (PNG, JPG, WEBP) are allowed for delivery proofs.', 400
        
    lat_str = request.form.get('latitude')
    lon_str = request.form.get('longitude')
    
    if not lat_str or not lon_str:
        return jsonify({"error": "GPS coordinates (latitude and longitude) are required for photo uploads to verify location."}), 400
        
    try:
        photo_lat = float(lat_str)
        photo_lon = float(lon_str)
    except ValueError:
        return jsonify({"error": "Invalid GPS coordinates provided."}), 400

    # Geofencing Check: Verify the photo coordinates match the load's delivery address
    cursor.execute("SELECT delivery FROM loads WHERE load_id = ?", (load_id,))
    load_row = cursor.fetchone()
    if not load_row:
        return jsonify({"error": "Load not found."}), 404
        
    delivery_address = load_row[0]
    expected_lat, expected_lon = geocode_address(delivery_address)
    
    if expected_lat is not None and expected_lon is not None:
        distance_miles = calculate_distance(photo_lat, photo_lon, expected_lat, expected_lon)
        
        if distance_miles > 1.0:
            return jsonify({"error": f"Delivery photo rejected: Location is {distance_miles:.2f} miles away from the target delivery destination."}), 400
    else:
        print(f"Warning: Could not geocode delivery address '{delivery_address}' for load {load_id}. Skipping strict geofence validation.")

    if file:
        filename = secure_filename(file.filename)
        upload_folder = current_app.config['UPLOAD_FOLDER']
        os.makedirs(upload_folder, exist_ok=True)
        unique_filename = f"{load_id}_{filename}"
        save_path = os.path.join(upload_folder, unique_filename)
        
        file.save(save_path)

        cursor.execute(
            "INSERT INTO delivery_proofs (load_id, image_path, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?)",
            (load_id, save_path, photo_lat, photo_lon, time.time())
        )
        conn.commit()
        release_escrow_funds(load_id, cursor)
        notify_shipper_delivery(load_id)
        print(f"Delivery proof for load '{load_id}' saved to {save_path}")
        return f"File '{filename}' for load {load_id} uploaded successfully!"

    return 'An unknown error occurred while uploading.', 500

@tracking_bp.route('/submit_pod/<match_id>', methods=['GET', 'POST'])
@login_required
def submit_pod(match_id):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT m.load_id, v.user_id as transporter_id 
        FROM matches m
        JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        WHERE m.match_id = ?
    """, (match_id,))
    match_info = cursor.fetchone()

    if not match_info:
        return "Match not found", 404

    if match_info['transporter_id'] != session['user_id']:
        return "Unauthorized: Only the transporter can submit the POD.", 403
        
    load_id = match_info['load_id']

    if request.method == 'POST':
        signature = request.form.get('signature')
        file = request.files.get('delivery_proof_pic')
        
        if signature:
            cursor.execute(
                "INSERT INTO delivery_proofs (load_id, signature, timestamp) VALUES (?, ?, ?)",
                (load_id, signature, time.time())
            )
        elif file and file.filename != '':
            lat_str = request.form.get('latitude')
            lon_str = request.form.get('longitude')
            
            if not lat_str or not lon_str:
                return "GPS coordinates are required to submit a photo.", 400
            try:
                photo_lat = float(lat_str)
                photo_lon = float(lon_str)
            except ValueError:
                return "Invalid GPS coordinates.", 400
            if not allowed_file(file.filename, ALLOWED_IMAGE_EXTENSIONS):
                return "Invalid file type. Only images are allowed.", 400
            
            cursor.execute("SELECT delivery FROM loads WHERE load_id = ?", (load_id,))
            load_row = cursor.fetchone()
            if load_row:
                expected_lat, expected_lon = geocode_address(load_row[0])
                if expected_lat is not None and expected_lon is not None:
                    distance_miles = calculate_distance(photo_lat, photo_lon, expected_lat, expected_lon)
                    if distance_miles > 1.0:
                        return f"Delivery photo rejected: Location is {distance_miles:.2f} miles away from the target delivery destination.", 400

            filename = secure_filename(file.filename)
            upload_folder = current_app.config['UPLOAD_FOLDER']
            os.makedirs(upload_folder, exist_ok=True)
            unique_filename = f"{load_id}_{filename}"
            save_path = os.path.join(upload_folder, unique_filename)
            file.save(save_path)

            cursor.execute(
                "INSERT INTO delivery_proofs (load_id, image_path, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?)",
                (load_id, save_path, photo_lat, photo_lon, time.time())
            )
        else:
            return "No signature or file provided.", 400

        conn.commit()
        release_escrow_funds(load_id, cursor)
        notify_shipper_delivery(load_id)
        return redirect(url_for('dashboard'))

    return render_template('submit_pod.html', match_id=match_id, load_id=load_id)

@tracking_bp.route('/update-location', methods=['POST'])
def update_location():
    load_id = request.form.get('load_id')
    latitude = request.form.get('latitude')
    longitude = request.form.get('longitude')
    
    if not load_id or not latitude or not longitude:
        return jsonify({"error": "Missing load_id, latitude, or longitude"}), 400
        
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT OR REPLACE INTO locations (load_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?)",
        (load_id, latitude, longitude, time.time())
    )
    conn.commit()
    
    print(f"Location updated for load {load_id}: {latitude}, {longitude}")
    return jsonify({"status": "Location updated successfully!", "load_id": load_id}), 200

@tracking_bp.route('/track-load/<load_id>', methods=['GET'])
def track_load(load_id):
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM locations WHERE load_id = ?", (load_id,))
    location_row = cursor.fetchone()

    if location_row:
        return jsonify(dict(location_row)), 200
    else:
        return jsonify({"error": "Load ID not found or no location data available."}), 404

@tracking_bp.route('/view-delivery-proof/<load_id>')
@login_required
def view_delivery_proof(load_id):
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT l.user_id as shipper_id, v.user_id as transporter_id
        FROM loads l
        LEFT JOIN matches m ON l.load_id = m.load_id
        LEFT JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        WHERE l.load_id = ?
    """, (load_id,))
    load_users = cursor.fetchone()
    
    if not load_users or session['user_id'] not in [load_users['shipper_id'], load_users['transporter_id']]:
        return "Unauthorized access.", 403

    cursor.execute("SELECT * FROM delivery_proofs WHERE load_id = ?", (load_id,))
    proof = cursor.fetchone()
    
    cursor.execute("SELECT payment_status FROM loads WHERE load_id = ?", (load_id,))
    load_status = cursor.fetchone()
    
    if not proof:
        return "Delivery proof not found.", 404
        
    return render_template('view_delivery_proof.html', proof=proof, load_users=load_users, load_id=load_id, load_status=load_status)

@tracking_bp.route('/dispute-delivery/<load_id>', methods=['POST'])
@login_required
def dispute_delivery(load_id):
    user_id = session['user_id']
    reason = request.form.get('reason')
    
    if not reason:
        return "Dispute reason is required.", 400
        
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT user_id FROM loads WHERE load_id = ?", (load_id,))
    load_row = cursor.fetchone()
    
    if not load_row or load_row[0] != user_id:
        return "Unauthorized: Only the shipper can dispute this delivery.", 403
        
    cursor.execute("UPDATE loads SET payment_status = 'disputed' WHERE load_id = ?", (load_id,))
    
    cursor.execute("INSERT INTO dispute_evidence (load_id, user_id, comments, timestamp) VALUES (?, ?, ?, ?)",
                   (load_id, user_id, f"Shipper disputed delivery proof: {reason}", time.time()))
                   
    conn.commit()
    
    notify_dispute_created(load_id)
    
    return redirect(url_for('dashboard'))

@tracking_bp.route('/delivery_proofs/<path:filename>')
@login_required
def serve_delivery_proof(filename):
    """Serves the securely uploaded delivery proof images."""
    return send_from_directory(current_app.config['UPLOAD_FOLDER'], filename)