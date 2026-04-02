import os
import uuid
import time
import sqlite3
import stripe
from flask import Blueprint, request, redirect, url_for, jsonify, session, current_app
from werkzeug.utils import secure_filename

# Delay the import of main's utilities until after initialization
# to avoid circular dependency loops in Flask
from main import login_required, verification_required, send_email, allowed_file, ALLOWED_DOC_EXTENSIONS, get_db

payments_bp = Blueprint('payments', __name__)

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DATABASE = os.path.join(BASE_DIR, 'trucking.db')

# Stripe Setup
stripe.api_key = os.environ.get('STRIPE_SECRET_KEY')

def release_escrow_funds(load_id, cursor):
    """Releases funds to the transporter when delivery is confirmed."""
    cursor.execute("""
        SELECT l.offer, l.payment_status, u.stripe_account_id
        FROM loads l
        JOIN matches m ON l.load_id = m.load_id
        JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        JOIN users u ON v.user_id = u.user_id
        WHERE l.load_id = ? AND l.payment_status = 'paid'
    """, (load_id,))
    load_data = cursor.fetchone()
    
    if load_data and load_data[2]: # Ensure they have a connected Stripe Account
        offer_amount_cents = int(float(load_data[0]) * 100)
        platform_fee_cents = int(offer_amount_cents * 0.10) # E.g., App keeps a 10% cut
        payout_amount_cents = offer_amount_cents - platform_fee_cents
        
        try:
            stripe.Transfer.create(
                amount=payout_amount_cents,
                currency="usd",
                destination=load_data[2],
                transfer_group=load_id,
                description=f"Delivery payout for load {load_id}"
            )
            print(f"Escrow released: {payout_amount_cents} cents transferred to {load_data[2]}")
        except stripe.error.StripeError as e:
            print(f"Stripe Transfer Error for load {load_id}: {e}")

def notify_dispute_created(load_id):
    """Sends an email to the shipper and transporter notifying them of a payment dispute."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get Shipper email and Load description
    cursor.execute("""
        SELECT u.email, l.description 
        FROM loads l
        JOIN users u ON l.user_id = u.user_id
        WHERE l.load_id = ?
    """, (load_id,))
    shipper_row = cursor.fetchone()
    
    # Get Transporter email
    cursor.execute("""
        SELECT u.email
        FROM matches m
        JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        JOIN users u ON v.user_id = u.user_id
        WHERE m.load_id = ?
    """, (load_id,))
    transporter_row = cursor.fetchone()
    
    conn.close()
    
    emails_to_notify = []
    if shipper_row and shipper_row['email']:
        emails_to_notify.append(shipper_row['email'])
    if transporter_row and transporter_row['email']:
        emails_to_notify.append(transporter_row['email'])
        
    if emails_to_notify and shipper_row:
        text_content = f"Hello,\n\nA payment dispute has been opened for the load: '{shipper_row['description']}'.\n\nPlease check your dashboard and contact support to provide any necessary evidence or context.\n\nThank you for using GottaBackhaul."
        send_email(", ".join(emails_to_notify), f"Action Required: Dispute Opened for '{shipper_row['description']}'", text_content)

def notify_dispute_resolved(load_id, status):
    """Sends an email to the transporter notifying them of the dispute outcome."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get Transporter email and Load description
    cursor.execute("""
        SELECT u.email, l.description 
        FROM matches m
        JOIN vehicles v ON m.vehicle_id = v.vehicle_id
        JOIN users u ON v.user_id = u.user_id
        JOIN loads l ON m.load_id = l.load_id
        WHERE m.load_id = ?
    """, (load_id,))
    row = cursor.fetchone()
    conn.close()
    
    if row and row['email']:
        if status == 'won':
            text_content = f"Hello,\n\nWe have successfully won the payment dispute for the load: '{row['description']}'.\n\nThe funds will remain in your account and no further action is required from you.\n\nThank you for using GottaBackhaul."
            subject = f"Good News: Dispute Won for '{row['description']}'"
        else:
            text_content = f"Hello,\n\nUnfortunately, the bank has ruled in favor of the cardholder for the dispute on the load: '{row['description']}'.\n\nThe funds for this load will be reversed from your account. If you have questions, please contact support.\n\nThank you for using GottaBackhaul."
            subject = f"Update: Dispute Lost for '{row['description']}'"
        send_email(row['email'], subject, text_content)

@payments_bp.route('/create-checkout-session/<load_id>', methods=['POST'])
@verification_required
def create_checkout_session(load_id):
    """Creates a Stripe Checkout session for a specific load."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM loads WHERE load_id = ?", (load_id,))
    load = cursor.fetchone()
    conn.close()

    if not load:
        return "Load not found", 404

    if load['user_id'] != session['user_id']:
        return "Unauthorized", 403

    try:
        offer_amount = int(float(load['offer']) * 100)
        
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=['card'],
            line_items=[{
                'price_data': {
                    'currency': 'usd',
                    'product_data': {
                        'name': f"Payment for: {load['description']}",
                    },
                    'unit_amount': offer_amount,
                },
                'quantity': 1,
            }],
            mode='payment',
            success_url=url_for('payments.payment_success', load_id=load_id, _external=True),
            cancel_url=url_for('payments.payment_cancel', _external=True),
            payment_intent_data={
                'transfer_group': load_id,
                'metadata': {
                    'load_id': load_id
                }
            },
            metadata={
                'load_id': load_id
            }
        )
        return redirect(checkout_session.url, code=303)
    except Exception as e:
        print(f"Error creating Stripe session: {e}")
        return "Error creating payment session.", 500

@payments_bp.route('/payment-success')
def payment_success():
    load_id = request.args.get('load_id')
    if load_id:
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("UPDATE loads SET payment_status = 'paid' WHERE load_id = ?", (load_id,))
        conn.commit()
        conn.close()
        print(f"Load {load_id} marked as paid.")
    return f'<h1>Payment Successful!</h1><p>Your payment for load {load_id or ""} was processed.</p><a href="{url_for("dashboard")}">Go to Dashboard</a>'

@payments_bp.route('/payment-cancel')
def payment_cancel():
    return f'<h1>Payment Canceled</h1><p>Your payment was not processed. You can try again from the dashboard.</p><a href="{url_for("dashboard")}">Go to Dashboard</a>'

@payments_bp.route('/stripe-webhook', methods=['POST'])
def stripe_webhook():
    payload = request.data
    sig_header = request.headers.get('Stripe-Signature')
    endpoint_secret = os.environ.get('STRIPE_WEBHOOK_SECRET')

    if not endpoint_secret:
        print("⚠️  Stripe webhook secret not configured in .env.")
        return jsonify({'error': 'Webhook secret not configured'}), 500

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, endpoint_secret)
    except Exception as e:
        return "Invalid signature or payload", 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    if event['type'] == 'charge.refunded':
        charge = event['data']['object']
        load_id = charge.get('metadata', {}).get('load_id')
        if load_id:
            cursor.execute("UPDATE loads SET payment_status = 'refunded' WHERE load_id = ?", (load_id,))
            
    elif event['type'] == 'charge.dispute.created':
        dispute = event['data']['object']
        try:
            charge = stripe.Charge.retrieve(dispute['charge'])
            load_id = charge.get('metadata', {}).get('load_id')
            if load_id:
                cursor.execute("UPDATE loads SET payment_status = 'disputed', stripe_dispute_id = ? WHERE load_id = ?", (dispute['id'], load_id))
                notify_dispute_created(load_id)
        except Exception as e:
            print(f"Error retrieving charge for dispute: {e}")
            
    elif event['type'] == 'charge.dispute.closed':
        dispute = event['data']['object']
        try:
            charge = stripe.Charge.retrieve(dispute['charge'])
            load_id = charge.get('metadata', {}).get('load_id')
            if load_id:
                status = 'dispute_won' if dispute['status'] == 'won' else 'dispute_lost'
                cursor.execute("UPDATE loads SET payment_status = ? WHERE load_id = ?", (status, load_id))
                notify_dispute_resolved(load_id, dispute['status'])
        except Exception as e:
            print(f"Error retrieving charge for closed dispute: {e}")
            
    elif event['type'] == 'account.updated':
        account = event['data']['object']
        if account.get('details_submitted'):
            stripe_account_id = account.get('id')
            if stripe_account_id:
                cursor.execute("UPDATE users SET id_verified = 1 WHERE stripe_account_id = ?", (stripe_account_id,))

    conn.commit()
    conn.close()
    return jsonify({'status': 'success'}), 200

@payments_bp.route('/submit-evidence/<load_id>', methods=['POST'])
@login_required
def submit_evidence(load_id):
    user_id = session['user_id']
    comments = request.form.get('comments')
    file = request.files.get('evidence_file')
    service_date = request.form.get('service_date')
    shipping_tracking_number = request.form.get('shipping_tracking_number')

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT l.stripe_dispute_id, u.email, l.ip_address
        FROM loads l JOIN users u ON l.user_id = u.user_id
        WHERE l.load_id = ?
    """, (load_id,))
    load_row = cursor.fetchone()
    dispute_id = load_row[0] if load_row else None
    customer_email = load_row[1] if load_row else None
    customer_ip = load_row[2] if load_row else None
    
    cursor.execute("SELECT image_path FROM delivery_proofs WHERE load_id = ?", (load_id,))
    proof_row = cursor.fetchone()
    delivery_proof_path = proof_row[0] if proof_row else None

    save_path = None
    if file and file.filename != '':
        if not allowed_file(file.filename, ALLOWED_DOC_EXTENSIONS):
            return "Invalid file type. Only documents and images are allowed for evidence.", 400
        filename = secure_filename(file.filename)
        evidence_dir = os.path.join(current_app.config['UPLOAD_FOLDER'], 'evidence')
        os.makedirs(evidence_dir, exist_ok=True)
        unique_filename = f"evidence_{load_id}_{uuid.uuid4().hex[:8]}_{filename}"
        save_path = os.path.join(evidence_dir, unique_filename)
        file.save(save_path)
        
    if dispute_id:
        evidence_payload = {}
        if comments: evidence_payload['uncategorized_text'] = comments
        if customer_email: evidence_payload['customer_email_address'] = customer_email
        if customer_ip: evidence_payload['customer_purchase_ip'] = customer_ip
        if service_date: evidence_payload['service_date'] = service_date
        if shipping_tracking_number: evidence_payload['shipping_tracking_number'] = shipping_tracking_number
            
        if save_path:
            try:
                with open(save_path, 'rb') as f:
                    stripe_evidence_file = stripe.File.create(purpose='dispute_evidence', file=f)
                    evidence_payload['uncategorized_file'] = stripe_evidence_file.id
            except Exception as e:
                print(f"Stripe evidence file upload failed: {e}")
        
        if delivery_proof_path and os.path.exists(delivery_proof_path):
            try:
                with open(delivery_proof_path, 'rb') as f:
                    stripe_proof_file = stripe.File.create(purpose='dispute_evidence', file=f)
                    evidence_payload['shipping_documentation'] = stripe_proof_file.id
            except Exception as e:
                print(f"Stripe delivery proof upload failed: {e}")

        if evidence_payload:
            try:
                stripe.Dispute.modify(dispute_id, evidence=evidence_payload)
            except Exception as e:
                print(f"Stripe dispute update failed: {e}")
                
    cursor.execute("INSERT INTO dispute_evidence (load_id, user_id, comments, file_path, timestamp) VALUES (?, ?, ?, ?, ?)",
                   (load_id, user_id, comments, save_path, time.time()))
    cursor.execute("UPDATE loads SET payment_status = 'dispute_under_review' WHERE load_id = ?", (load_id,))
    conn.commit()
    conn.close()
    
    return redirect(url_for('dashboard'))

@payments_bp.route('/stripe_onboarding')
@login_required
def stripe_onboarding():
    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    stripe_account_id = user['stripe_account_id']
    
    if not stripe_account_id:
        try:
            account = stripe.Account.create(
                type='express',
                email=user['email'],
                capabilities={'transfers': {'requested': True}},
                business_type='individual',
            )
            stripe_account_id = account.id
            cursor.execute("UPDATE users SET stripe_account_id = ? WHERE user_id = ?", (stripe_account_id, user_id))
            conn.commit()
        except Exception as e:
            conn.close()
            return "An error occurred creating your secure payment account.", 500
            
    conn.close()
    
    try:
        account_link = stripe.AccountLink.create(
            account=stripe_account_id,
            refresh_url=url_for('payments.stripe_onboarding', _external=True),
            return_url=url_for('payments.stripe_return', _external=True),
            type='account_onboarding',
        )
        return redirect(account_link.url)
    except Exception as e:
        return "An error occurred connecting to Stripe.", 500

@payments_bp.route('/stripe-return')
@login_required
def stripe_return():
    user_id = session['user_id']
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT stripe_account_id FROM users WHERE user_id = ?", (user_id,))
    user = cursor.fetchone()
    
    if user and user['stripe_account_id']:
        try:
            account = stripe.Account.retrieve(user['stripe_account_id'])
            if account.details_submitted:
                cursor.execute("UPDATE users SET id_verified = 1 WHERE user_id = ?", (user_id,))
                conn.commit()
        except Exception as e:
            print(f"Failed to retrieve Stripe account: {e}")
            
    conn.close()
    return redirect(url_for('edit_profile'))