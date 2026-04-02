import sqlite3
from main import DATABASE

def test_post_load_success(client, add_user, app, monkeypatch):
    """
    GIVEN a verified shipper
    WHEN they submit valid load details to /post-load
    THEN the load is added to the database and they are redirected to the dashboard.
    """
    # 1. Create a shipper with identity verified (id_verified=1)
    shipper = add_user(
        username="shipper_test", 
        email="shipper@example.com", 
        password="pw", 
        role="shipper",
        id_verified=1
    )

    # 2. Mock external APIs to prevent actual network calls to mapping services
    monkeypatch.setattr('shipments.geocode_address', lambda addr: (40.7128, -74.0060))
    monkeypatch.setattr('shipments.get_ip_location', lambda ip: (40.7128, -74.0060))

    # 3. Log the user in
    with client:
        client.post('/login', data={'username': shipper['username'], 'password': shipper['password']})
        
        # Manually bypass the 2FA wall required by @verification_required
        with client.session_transaction() as session:
            session['is_verified'] = True
            
        # 4. Make the POST request to create a load
        load_data = {
            'description': 'Test Load of Steel',
            'weight': '40000 lbs',
            'dimensions': '53ft',
            'pickup': 'New York, NY',
            'delivery': 'Chicago, IL',
            'shipper_offer': '1500',
            'shipping_date': '2025-01-01'
        }
        
        response = client.post('/post-load', data=load_data, follow_redirects=True)

        # 5. Assert the request was successful (redirected to dashboard and load is visible)
        assert response.status_code == 200
        assert b"Test Load of Steel" in response.data

        # 6. Verify the load was inserted into the database accurately
        with app.app_context():
            conn = sqlite3.connect(DATABASE)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM loads WHERE user_id = ?", (shipper['user_id'],))
            loads = cursor.fetchall()
            conn.close()

        assert len(loads) == 1
        assert loads[0]['description'] == 'Test Load of Steel'
        assert float(loads[0]['offer']) == 1500.0
        assert loads[0]['is_flagged'] == 0

def test_post_load_fails_for_transporter(client, add_user):
    transporter = add_user(username="trans1", email="t1@example.com", password="pw", role="transporter", id_verified=1)
    with client:
        client.post('/login', data={'username': transporter['username'], 'password': transporter['password']})
        with client.session_transaction() as session: session['is_verified'] = True
        response = client.post('/post-load', data={'shipper_offer': '1000'})
        
        assert response.status_code == 403
        assert b"Only shippers can post loads" in response.data

def test_post_load_invalid_offer(client, add_user):
    shipper = add_user(username="cheap_shipper", email="cheap@example.com", password="pw", role="shipper", id_verified=1)
    with client:
        client.post('/login', data={'username': shipper['username'], 'password': shipper['password']})
        with client.session_transaction() as session: session['is_verified'] = True
        response = client.post('/post-load', data={'shipper_offer': '5'}) # Below $10 minimum
        assert response.status_code == 400

def test_match_load_success(client, add_user, app, monkeypatch):
    """
    GIVEN a verified user, a load, and a vehicle
    WHEN a POST request is made to /match-load
    THEN a match is created and both parties are notified via email.
    """
    # 1. Mock the email function to just record who it was sent to
    emails_sent = []
    monkeypatch.setattr('shipments.send_email', lambda to, sub, text, **kw: emails_sent.append(to) or True)

    # 2. Setup Database records (Shipper, Transporter, Load, Vehicle)
    shipper = add_user(username="shipper2", email="s2@example.com", password="pw", role="shipper", id_verified=1)
    transporter = add_user(username="trans2", email="t2@example.com", password="pw", role="transporter", id_verified=1)
    
    with app.app_context():
        conn = sqlite3.connect(DATABASE)
        conn.execute("INSERT INTO loads (load_id, user_id, description, timestamp) VALUES (?, ?, ?, ?)", 
                     ("load-X", shipper['user_id'], "Stuff", 123.0))
        conn.execute("INSERT INTO vehicles (vehicle_id, user_id, vehicle_type, timestamp) VALUES (?, ?, ?, ?)", 
                     ("veh-Y", transporter['user_id'], "Truck", 123.0))
        conn.commit()
        conn.close()

    # 3. Log in and make the match request
    with client:
        client.post('/login', data={'username': shipper['username'], 'password': shipper['password']})
        with client.session_transaction() as sess: sess['is_verified'] = True
        
        response = client.post('/match-load', data={'load_id': 'load-X', 'vehicle_id': 'veh-Y'})

    # 4. Assert the match was successful, inserted into the DB, and emails sent
    assert response.status_code == 201
    with app.app_context():
        conn = sqlite3.connect(DATABASE)
        assert conn.execute("SELECT * FROM matches WHERE load_id = 'load-X' AND vehicle_id = 'veh-Y'").fetchone() is not None
        conn.close()
    assert shipper['email'] in emails_sent
    assert transporter['email'] in emails_sent