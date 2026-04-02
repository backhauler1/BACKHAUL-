import os
import re
import time
import uuid
import sqlite3
from flask import Blueprint, request, jsonify, redirect, url_for, session

# Import shared dependencies from the main application file
from main import (
    DATABASE, verification_required, limiter, send_email,
    geocode_address, get_ip_location, calculate_distance, verify_fmcsa_broker
)

shipments_bp = Blueprint('shipments', __name__)

@shipments_bp.route('/post-load', methods=['POST'])
@verification_required
@limiter.limit("10 per hour") # Fraud Prevention 1: Rate limiting to prevent bot flooding
def post_load():
    if session.get('role') != 'shipper':
        return jsonify({"error": "Only shippers can post loads."}), 403

    description = request.form.get('description')
    weight = request.form.get('weight')
    dimensions = request.form.get('dimensions')
    pickup = request.form.get('pickup')
    delivery = request.form.get('delivery')
    offer = request.form.get('shipper_offer')
    shipping_date = request.form.get('shipping_date')
    ip_address = request.remote_addr

    # Fraud Prevention 2: Sanity bounds checking on the financial offer
    try:
        offer_amount = float(offer)
        if offer_amount < 10 or offer_amount > 50000:
            return jsonify({"error": "Offer must be between $10 and $50,000."}), 400
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid offer amount provided."}), 400

    # Fraud Prevention 3: Redact contact info to prevent off-platform scams
    if description:
        # Redact potential emails
        description = re.sub(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', '[EMAIL REDACTED]', description)
        # Redact potential phone numbers
        description = re.sub(r'\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}', '[PHONE REDACTED]', description)

    # Generate a unique ID for the new load
    load_id = str(uuid.uuid4())
    user_id = session['user_id']

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    # Fetch the user's DOT number, broker status, and ID verification status
    cursor.execute("SELECT dot_number, is_broker_verified, mc_certificate_path, id_verified, is_traveler_verified FROM users WHERE user_id = ?", (user_id,))
    user_row = cursor.fetchone()
    dot_number = user_row[0] if user_row else None
    is_broker_verified = user_row[1] if user_row else 0
    mc_cert_path = user_row[2] if user_row else None
    id_verified = user_row[3] if user_row else 0
    is_traveler_verified = user_row[4] if user_row else 0

    if not id_verified:
        conn.close()
        return jsonify({"error": "Identity verification required. Please connect securely with Stripe in your profile settings."}), 403

    # Fraud Prevention 4: IP Geolocation Validation
    is_flagged = 0
    if pickup and ip_address:
        pickup_lat, pickup_lon = geocode_address(pickup)
        ip_lat, ip_lon = get_ip_location(ip_address)
        
        if pickup_lat is not None and ip_lat is not None:
            distance_miles = calculate_distance(ip_lat, ip_lon, pickup_lat, pickup_lon)
            print(f"Distance between IP location and pickup: {distance_miles:.2f} miles")
            
            # If the user is posting a load more than 1,000 miles away...
            if distance_miles > 1000:
                # ...Check if they are a verified broker first to avoid falsely flagging them!
                if is_broker_verified == 1:
                    print("User is a verified broker. Bypassing geolocation flag.")
                elif dot_number and verify_fmcsa_broker(dot_number):
                    print(f"User DOT {dot_number} verified as active broker. Bypassing flag.")
                    # Cache the verification so we don't have to hit the API every time they post
                    cursor.execute("UPDATE users SET is_broker_verified = 1 WHERE user_id = ?", (user_id,))
                    conn.commit()
                elif is_traveler_verified == 1:
                    print("User is a verified personal traveler. Bypassing geolocation flag.")
                else:
                    if mc_cert_path:
                        is_flagged = 1
                        print(f"Security Alert: Load flagged due to distance ({distance_miles:.0f} miles). User has secondary MC cert.")
                    else:
                        conn.close()
                        return jsonify({"error": "Automated DOT verification failed for long-distance load. Please edit your profile and upload your MC Certificate or Personal ID/Insurance as secondary proof."}), 400

    cursor.execute(
        "INSERT INTO loads (load_id, user_id, description, weight, dimensions, pickup, delivery, offer, shipping_date, timestamp, ip_address, is_flagged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (load_id, user_id, description, weight, dimensions, pickup, delivery, offer, shipping_date, time.time(), ip_address, is_flagged)
    )
    conn.commit()
    conn.close()

    # Fraud Prevention 5: Automatically notify admin of flagged loads
    if is_flagged == 1:
        # We default to sending it to your primary email, but you can set ADMIN_EMAIL in your .env
        admin_email = os.environ.get("ADMIN_EMAIL", "gottabackhaul@gmail.com")
        text_content = (
            f"Security Alert: A newly posted load has been flagged for suspicious geolocation activity.\n\n"
            f"User: {session.get('username')}\n"
            f"Pickup Location: {pickup}\n"
            f"User IP Address: {ip_address}\n"
            f"IP Reputation Check: https://www.abuseipdb.com/check/{ip_address}\n"
            f"Load ID: {load_id}\n\n"
            f"The user's IP location is > 1,000 miles away from the pickup location.\n"
            f"This load has been QUARANTINED and is hidden from the public feed.\n"
            f"Please verify its legitimacy before approving it on the Admin Dashboard."
        )
        send_email(admin_email, "Action Required: Suspicious Load Flagged", text_content)

    print(f'Received and saved load {load_id}: {description}, weight: {weight}, offer: {offer}')
    # Redirect to dashboard to see the new listing
    return redirect(url_for('dashboard'))

@shipments_bp.route('/post-vehicle', methods=['POST'])
@verification_required
def post_vehicle():
    if session.get('role') != 'transporter':
        return jsonify({"error": "Only transporters can post vehicles."}), 403

    """
    Allows any driver (truckers, personal vehicle owners, couriers) to post their availability.
    """
    vehicle_type = request.form.get('vehicle_type') 
    departure_city = request.form.get('departure_city')
    destination_city = request.form.get('destination_city')
    start_date = request.form.get('start_date')
    end_date = request.form.get('end_date')
    max_weight = request.form.get('max_weight')
    max_dimensions = request.form.get('max_dimensions')
    
    vehicle_id = str(uuid.uuid4())
    user_id = session['user_id']

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    cursor.execute("SELECT id_verified FROM users WHERE user_id = ?", (user_id,))
    user_row = cursor.fetchone()
    if not user_row or not user_row[0]:
        conn.close()
        return jsonify({"error": "Identity verification required. Please connect securely with Stripe in your profile settings."}), 403

    cursor.execute(
        "INSERT INTO vehicles (vehicle_id, user_id, vehicle_type, departure_city, destination_city, start_date, end_date, max_weight, max_dimensions, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (vehicle_id, user_id, vehicle_type, departure_city, destination_city, start_date, end_date, max_weight, max_dimensions, time.time())
    )
    conn.commit()
    conn.close()

    print(f'Received vehicle {vehicle_id}: {vehicle_type} (Max weight: {max_weight}, Max dims: {max_dimensions}), route: {departure_city} to {destination_city}')
    return redirect(url_for('dashboard'))

@shipments_bp.route('/match-load', methods=['POST'])
@verification_required
def match_load():
    """
    Assigns a specific load to a specific vehicle/driver.
    """
    load_id = request.form.get('load_id')
    vehicle_id = request.form.get('vehicle_id')

    if not load_id or not vehicle_id:
        return jsonify({"error": "Both 'load_id' and 'vehicle_id' are required."}), 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    user_id = session.get('user_id')
    cursor.execute("SELECT id_verified FROM users WHERE user_id = ?", (user_id,))
    user_row = cursor.fetchone()
    if not user_row or not user_row[0]:
        conn.close()
        return jsonify({"error": "Identity verification required. Please connect securely with Stripe in your profile settings."}), 403

    cursor.execute("SELECT load_id FROM loads WHERE load_id = ?", (load_id,))
    if not cursor.fetchone():
        return jsonify({"error": f"Load ID '{load_id}' not found."}), 404
        
    cursor.execute("SELECT vehicle_id FROM vehicles WHERE vehicle_id = ?", (vehicle_id,))
    if not cursor.fetchone():
        return jsonify({"error": f"Vehicle ID '{vehicle_id}' not found."}), 404

    match_id = str(uuid.uuid4())
    cursor.execute(
        "INSERT INTO matches (match_id, load_id, vehicle_id, timestamp) VALUES (?, ?, ?, ?)",
        (match_id, load_id, vehicle_id, time.time())
    )
    conn.commit()
    conn.close()

    print(f"Successfully matched load {load_id} to vehicle {vehicle_id} (Match ID: {match_id})")
    return jsonify({"message": "Load successfully matched to vehicle!", "match_id": match_id}), 201