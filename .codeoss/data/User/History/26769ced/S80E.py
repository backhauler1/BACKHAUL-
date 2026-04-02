import os
import time
from flask import Blueprint, request, jsonify, current_app, redirect, url_for
from werkzeug.utils import secure_filename

# Delay the import of main's utilities until after initialization
# to avoid circular dependency loops in Flask
from main import login_required, get_db

tracking_bp = Blueprint('tracking', __name__)

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
    latitude = request.form.get('latitude')
    longitude = request.form.get('longitude')
    file = request.files.get('delivery_proof_pic')

    save_path = None
    if file and file.filename != '':
        filename = secure_filename(file.filename)
        
        # Ensure the upload directory exists
        os.makedirs(current_app.config['UPLOAD_FOLDER'], exist_ok=True)
        
        unique_filename = f"{load_id}_{filename}"
        save_path = os.path.join(current_app.config['UPLOAD_FOLDER'], unique_filename)
        
        file.save(save_path)

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        INSERT INTO delivery_proofs (load_id, signature, image_path, latitude, longitude, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (load_id, signature, save_path, latitude, longitude, time.time()))

    # Automatically trigger escrow payout release to the transporter
    try:
        from payments import release_escrow_funds
        release_escrow_funds(load_id, cursor)
    except ImportError as e:
        print(f"Payments module missing or failed: {e}")

    conn.commit()

    # Return JSON for frontend consumption
    return jsonify({"message": "Delivery confirmed successfully!", "load_id": load_id}), 200