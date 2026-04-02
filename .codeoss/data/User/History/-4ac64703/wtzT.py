import os
import time
import uuid
from flask import Flask, request, jsonify, render_template
from werkzeug.utils import secure_filename


# Define a folder to store uploads
UPLOAD_FOLDER = 'delivery_proofs'

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# In-memory dictionary to store mock tracking data.
# In a real application, you would use a proper database (e.g., PostgreSQL, Firebase, MongoDB).
tracking_db = {}

# In-memory dictionary to store available trucks
trucks_db = {}

# In-memory dictionary to store posted loads
loads_db = {}

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/post-truck', methods=['POST'])
def receive_truck_details():
  truck_type = request.form.get('vehicle_type')
  departure_city = request.form.get('departure_city')
  destination_city = request.form.get('destination_city')
  start_date = request.form.get('start_date')
  end_date = request.form.get('end_date')

  # Generate a unique ID for the frontend to display
  vehicle_id = str(uuid.uuid4())

  # Save the truck data in our in-memory database
  trucks_db[vehicle_id] = {
      'vehicle_id': vehicle_id,
      'vehicle_type': truck_type,
      'departure_city': departure_city,
      'destination_city': destination_city,
      'start_date': start_date,
      'end_date': end_date
  }

  # প্রমাণ করো যে ডেটা পাওয়া গেছে
  print(f'Received truck: {truck_type}, route: {departure_city} to {destination_city}, dates: {start_date} to {end_date}')
  
  return jsonify({"message": "Truck details received!", "vehicle_id": vehicle_id}), 201

@app.route('/trucks')
def available_trucks():
    return render_template('trucks.html', trucks=trucks_db.values())

@app.route('/post-load', methods=['POST'])
def receive_load_details():
    description = request.form.get('description')
    weight = request.form.get('weight')
    dimensions = request.form.get('dimensions')
    pickup = request.form.get('pickup')
    delivery = request.form.get('delivery')
    shipping_date = request.form.get('shipping_date')
    offer = request.form.get('shipper_offer')

    # Generate a unique ID for the frontend to display
    load_id = str(uuid.uuid4())

    print(f'Received load {load_id}: {description}, pickup: {pickup}, delivery: {delivery}')
    # Save the load data in our in-memory database
    loads_db[load_id] = {
        'load_id': load_id,
        'description': description,
        'weight': weight,
        'dimensions': dimensions,
        'pickup': pickup,
        'delivery': delivery,
        'shipping_date': shipping_date,
        'offer': offer
    }

    print(f'Received load {load_id}: {description}, pickup: {pickup}, delivery: {delivery}, date: {shipping_date}')
    return jsonify({"message": "Load details received!", "load_id": load_id}), 201

@app.route('/find-matches', methods=['POST'])
def find_matches():
    load_id = request.form.get('load_id')
    
    if load_id not in loads_db:
        return jsonify({"error": "Load ID not found. Please post a load first."}), 404
        
    load = loads_db[load_id]
    matches = []
    
    for vehicle_id, truck in trucks_db.items():
        # Simple string matching for routes (case-insensitive)
        route_match = False
        if load.get('pickup') and truck.get('departure_city') and load.get('delivery') and truck.get('destination_city'):
            if load['pickup'].strip().lower() == truck['departure_city'].strip().lower() and \
               load['delivery'].strip().lower() == truck['destination_city'].strip().lower():
                route_match = True
                
        # Simple date logic: load's shipping date falls between truck's start and end date
        date_match = True
        if load.get('shipping_date') and truck.get('start_date') and truck.get('end_date'):
            if not (truck['start_date'] <= load['shipping_date'] <= truck['end_date']):
                date_match = False
                
        if route_match and date_match:
            matches.append(truck)
            
    if matches:
        return jsonify({"message": f"Good news! Found {len(matches)} truck(s) matching your route and dates.", "matching_trucks": matches}), 200
    else:
        return jsonify({"message": "No matching trucks currently line up with this route and date."}), 200

@app.route('/match-load', methods=['POST'])
def match_load():
    load_id = request.form.get('load_id')
    vehicle_id = request.form.get('vehicle_id')

    match_id = str(uuid.uuid4())
    
    print(f"Successfully matched load {load_id} to vehicle {vehicle_id} (Match ID: {match_id})")
    return jsonify({"message": "Load successfully matched to vehicle!", "match_id": match_id}), 201

@app.route('/delivery-confirmation', methods=['POST'])
def delivery_confirmation():
    """
    Handles delivery confirmation via a text signature or an uploaded image.
    Expects a 'load_id' in the form data to identify the delivery.
    For signatures, expects a 'signature' field.
    For pictures, expects a file in the 'delivery_proof_pic' field.
    """
    # A load ID is crucial to associate the proof with a specific delivery.
    load_id = request.form.get('load_id', 'unknown_load')

    # --- Option 1: Handle text signature ---
    signature = request.form.get('signature')
    if signature:
        # In a real application, you would save this to your database.
        print(f"Received signature for load '{load_id}': {signature}")
        return f"Signature received for load {load_id}!"

    # --- Option 2: Handle image upload ---
    # Check if the post request has the file part
    if 'delivery_proof_pic' not in request.files:
        return 'No file part in the request. Please use the "delivery_proof_pic" field.', 400
    
    file = request.files['delivery_proof_pic']

    # If the user does not select a file, the browser submits an
    # empty file without a filename.
    if file.filename == '':
        return 'No file selected for upload.', 400

    if file:
        # Use a secure version of the filename.
        filename = secure_filename(file.filename)
        
        # Ensure the upload directory exists.
        os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
        
        # Create a unique filename to prevent overwriting existing files.
        unique_filename = f"{load_id}_{filename}"
        save_path = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
        
        file.save(save_path)
        print(f"Delivery proof for load '{load_id}' saved to {save_path}")
        return f"File '{filename}' for load {load_id} uploaded successfully!"

    return 'An unknown error occurred while uploading.', 500

@app.route('/update-location', methods=['POST'])
def update_location():
    """
    Receives GPS coordinates from a trucker's device and updates the load's location.
    """
    load_id = request.form.get('load_id')
    latitude = request.form.get('latitude')
    longitude = request.form.get('longitude')
    
    if not load_id or not latitude or not longitude:
        return jsonify({"error": "Missing load_id, latitude, or longitude"}), 400
        
    # Update the tracking database with the latest location and a timestamp
    tracking_db[load_id] = {
        "latitude": latitude,
        "longitude": longitude,
        "timestamp": time.time()
    }
    
    print(f"Location updated for load {load_id}: {latitude}, {longitude}")
    return jsonify({"status": "Location updated successfully!", "load_id": load_id}), 200

@app.route('/track-load/<load_id>', methods=['GET'])
def track_load(load_id):
    """
    Allows a shipper to retrieve the latest known location of a specific load.
    """
    if load_id in tracking_db:
        return jsonify(tracking_db[load_id]), 200
    else:
        return jsonify({"error": "Load ID not found or no location data available."}), 404

if __name__ == '__main__':
  app.run(debug=True)
