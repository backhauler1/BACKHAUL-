import os
import time
from flask import Blueprint, request, jsonify, current_app, redirect, url_for, render_template, session, send_from_directory
from werkzeug.utils import secure_filename

# Delay the import of main's utilities until after initialization
# to avoid circular dependency loops in Flask
from main import (
    login_required, get_db, allowed_file, ALLOWED_IMAGE_EXTENSIONS,
    geocode_address, calculate_distance, send_email
)

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

@tracking_bp.route('/update-location', methods=['POST'])
@login_required
def update_location():
    """
    Receives GPS coordinates from a trucker's device and updates the load's location.
    """
    load_id = request.form.get('load_id')
    latitude = request.form.get('latitude')
    longitude = request.form.get('longitude')
    
    if not load_id or not latitude or not longitude:
        return jsonify({"error": "Missing load_id, latitude, or longitude"}), 400
        
    conn = get_db()
    cursor = conn.cursor()
    
    # Update the locations table with the latest location and a timestamp.
    # load_id is the PRIMARY KEY, so we update it if a conflict occurs.
    cursor.execute("""
        INSERT INTO locations (load_id, latitude, longitude, timestamp) 
        VALUES (?, ?, ?, ?)
        ON CONFLICT(load_id) DO UPDATE SET 
            latitude=excluded.latitude, 
            longitude=excluded.longitude, 
            timestamp=excluded.timestamp
    """, (load_id, float(latitude), float(longitude), time.time()))
    
    conn.commit()
    
    return jsonify({"status": "Location updated successfully!", "load_id": load_id}), 200

@tracking_bp.route('/track-load/<load_id>', methods=['GET'])
@login_required
def track_load(load_id):
    """
    Allows a shipper to retrieve the latest known location of a specific load.
    """
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT latitude, longitude, timestamp FROM locations WHERE load_id = ?", (load_id,))
    location = cursor.fetchone()
    
    if location:
        return jsonify({
            "latitude": location['latitude'],
            "longitude": location['longitude'],
            "timestamp": location['timestamp']
        }), 200
    else:
        return jsonify({"error": "Load ID not found or no location data available."}), 404

@tracking_bp.route('/delivery-confirmation', methods=['POST'])
@login_required
def delivery_confirmation():
    """
    Handles delivery confirmation via a text signature or an uploaded image.
    Expects a 'load_id' in the form data to identify the delivery.
    For signatures, expects a 'signature' field.
    For pictures, expects a file in the 'delivery_proof_pic' field.
    """
    load_id = request.form.get('load_id')
    if not load_id:
        return jsonify({"error": "Missing load_id"}), 400

    signature = request.form.get('signature')
    file = request.files.get('delivery_proof_pic')

    conn = get_db()
    cursor = conn.cursor()

    if signature:
        cursor.execute("""
            INSERT INTO delivery_proofs (load_id, signature, timestamp)
            VALUES (?, ?, ?)
        """, (load_id, signature, time.time()))
    elif file and file.filename != '':
        if not allowed_file(file.filename, ALLOWED_IMAGE_EXTENSIONS):
            return jsonify({"error": "Invalid file type. Only images (PNG, JPG, WEBP) are allowed."}), 400
            
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
            
        delivery_note = None
        expected_lat, expected_lon = geocode_address(load_row['delivery'])
        if expected_lat is not None and expected_lon is not None:
            distance_miles = calculate_distance(photo_lat, photo_lon, expected_lat, expected_lon)
            if distance_miles > 1.0:
                return jsonify({"error": f"Delivery photo rejected: Location is {distance_miles:.2f} miles away from the target delivery destination."}), 400
            # Allow uploads from up to 25 miles away, but flag anything over 1 mile for review.
            if distance_miles > 25.0:
                return jsonify({"error": f"Delivery photo rejected: Location is {distance_miles:.1f} miles away from the target delivery destination. Please get closer to the destination to upload."}), 400
            elif distance_miles > 1.0:
                delivery_note = f"Note: Proof of delivery was uploaded {distance_miles:.1f} miles away from the destination."

        filename = secure_filename(file.filename)
        
        # Ensure the upload directory exists
        os.makedirs(current_app.config['UPLOAD_FOLDER'], exist_ok=True)
        
        unique_filename = f"{load_id}_{filename}"
        # Create a more unique filename to avoid any potential collisions
        unique_filename = f"{load_id}_{int(time.time())}_{filename}"
        save_path = os.path.join(current_app.config['UPLOAD_FOLDER'], unique_filename)
        
        file.save(save_path)

        cursor.execute("""
            INSERT INTO delivery_proofs (load_id, image_path, latitude, longitude, timestamp)
            VALUES (?, ?, ?, ?, ?)
        """, (load_id, save_path, photo_lat, photo_lon, time.time()))
            INSERT INTO delivery_proofs (load_id, image_path, latitude, longitude, timestamp, note)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (load_id, save_path, photo_lat, photo_lon, time.time(), delivery_note))
    else:
        return jsonify({"error": "No signature or file provided."}), 400

    # Automatically trigger escrow payout release to the transporter
    try:
        from payments import release_escrow_funds
        release_escrow_funds(load_id, cursor)
    except ImportError as e:
        print(f"Payments module missing or failed: {e}")

    conn.commit()
    notify_shipper_delivery(load_id)

    # Return JSON for frontend consumption
    return jsonify({"message": "Delivery confirmed successfully!", "load_id": load_id}), 200

@tracking_bp.route('/view-delivery-proof/<load_id>')
@login_required
def view_delivery_proof(load_id):
    """Displays the delivery photo and a map of where it was taken."""
    conn = get_db()
    cursor = conn.cursor()
    
    # Ensure the user is authorized to view this load's delivery proof
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
    """Allows a shipper to dispute a delivery if the proof is incorrect."""
    user_id = session['user_id']
    reason = request.form.get('reason')
    
    if not reason:
        return "Dispute reason is required.", 400
        
    conn = get_db()
    cursor = conn.cursor()
    
    # Verify user is the shipper
    cursor.execute("SELECT user_id FROM loads WHERE load_id = ?", (load_id,))
    load_row = cursor.fetchone()
    
    if not load_row or load_row['user_id'] != user_id:
        return "Unauthorized: Only the shipper can dispute this delivery.", 403
        
    # Mark the load as disputed
    cursor.execute("UPDATE loads SET payment_status = 'disputed' WHERE load_id = ?", (load_id,))
    
    # Save the dispute reason as evidence
    cursor.execute("INSERT INTO dispute_evidence (load_id, user_id, comments, timestamp) VALUES (?, ?, ?, ?)",
                   (load_id, user_id, f"Shipper disputed delivery proof: {reason}", time.time()))
                   
    conn.commit()
    
    try:
        from payments import notify_dispute_created
        notify_dispute_created(load_id)
    except ImportError:
        pass
    
    return redirect(url_for('dashboard'))

@tracking_bp.route('/delivery_proofs/<path:filename>')
@login_required
def serve_delivery_proof(filename):
    """Serves the securely uploaded delivery proof images."""
    return send_from_directory(current_app.config['UPLOAD_FOLDER'], filename)

@tracking_bp.route('/submit_pod/<match_id>', methods=['GET', 'POST'])
@login_required
def submit_pod(match_id):
    """Allows the transporter to submit Proof of Delivery (POD) for a matched load."""
    conn = get_db()
    cursor = conn.cursor()

    # Verify the match exists and the user is the assigned transporter
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

    return render_template('submit_pod.html', match_id=match_id, load_id=load_id)