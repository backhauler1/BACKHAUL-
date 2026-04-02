import sqlite3
import csv
import io
import datetime
from flask import Blueprint, request, redirect, url_for, render_template, Response, jsonify

# Delay the import of main's utilities until after initialization
# to avoid circular dependency loops in Flask
from main import DATABASE, admin_required

admin_bp = Blueprint('admin', __name__)

@admin_bp.route('/admin/dashboard')
@admin_required
def admin_dashboard():
    """Displays all flagged loads requiring admin review."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Pagination setup for dispute evidence
    page = request.args.get('page', 1, type=int)
    per_page = 10
    offset = (page - 1) * per_page

    cursor.execute("""
        SELECT l.*, u.username, u.email, u.mc_certificate_path
        FROM loads l 
        JOIN users u ON l.user_id = u.user_id 
        WHERE l.is_flagged = 1 
        ORDER BY l.timestamp DESC
    """)
    flagged_loads = cursor.fetchall()
    
    # Get total count to calculate total pages
    cursor.execute("SELECT COUNT(*) FROM dispute_evidence")
    total_evidence = cursor.fetchone()[0]
    total_pages = (total_evidence + per_page - 1) // per_page if total_evidence > 0 else 1

    # Fetch the history of all submitted dispute evidence
    cursor.execute("""
        SELECT de.*, u.username, l.description as load_description, l.stripe_dispute_id, l.admin_notes
        FROM dispute_evidence de
        JOIN users u ON de.user_id = u.user_id
        JOIN loads l ON de.load_id = l.load_id
        ORDER BY de.timestamp DESC
        LIMIT ? OFFSET ?
    """, (per_page, offset))
    dispute_evidence = cursor.fetchall()
    conn.close()
    
    return render_template('admin_dashboard.html', flagged_loads=flagged_loads, dispute_evidence=dispute_evidence, current_page=page, total_pages=total_pages)

@admin_bp.route('/admin/approve-load/<load_id>', methods=['POST'])
@admin_required
def approve_load(load_id):
    """Approves a flagged load, removing the flag."""
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("UPDATE loads SET is_flagged = 0 WHERE load_id = ?", (load_id,))
    conn.commit()
    conn.close()
    print(f"Admin approved flagged load {load_id}")
    return redirect(url_for('admin.admin_dashboard'))

@admin_bp.route('/admin/delete-load/<load_id>', methods=['POST'])
@admin_required
def delete_load(load_id):
    """Deletes a suspicious load entirely from the platform."""
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM loads WHERE load_id = ?", (load_id,))
    conn.commit()
    conn.close()
    print(f"Admin deleted flagged load {load_id}")
    return redirect(url_for('admin.admin_dashboard'))

@admin_bp.route('/admin/add-note/<load_id>', methods=['POST'])
@admin_required
def add_admin_note(load_id):
    """Allows an administrator to save private, internal notes regarding a load or dispute."""
    note = request.form.get('admin_notes')
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("UPDATE loads SET admin_notes = ? WHERE load_id = ?", (note, load_id))
    conn.commit()
    conn.close()
    return redirect(url_for('admin.admin_dashboard'))

@admin_bp.route('/admin/export-evidence-csv')
@admin_required
def export_evidence_csv():
    """Exports the dispute evidence history as a CSV file for administrators."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT de.evidence_id, de.timestamp, u.username, l.description as load_description, 
               l.stripe_dispute_id, de.comments, de.file_path
        FROM dispute_evidence de
        JOIN users u ON de.user_id = u.user_id
        JOIN loads l ON de.load_id = l.load_id
        ORDER BY de.timestamp DESC
    """)
    evidence_records = cursor.fetchall()
    conn.close()
    
    output = io.StringIO()
    writer = csv.writer(output)
    
    writer.writerow(['Evidence ID', 'Date', 'User', 'Load Description', 'Dispute ID', 'Comments', 'Attachment Path'])
    
    for row in evidence_records:
        date_str = datetime.datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d %H:%M:%S') if row['timestamp'] else ''
        writer.writerow([
            row['evidence_id'], date_str, row['username'], row['load_description'],
            row['stripe_dispute_id'] or 'N/A', row['comments'], row['file_path'] or 'No file'
        ])
        
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-disposition": "attachment; filename=dispute_evidence_history.csv"}
    )

@admin_bp.route('/admin/analytics', methods=['GET'])
@admin_required
def admin_analytics():
    """Returns core platform analytics like dispute rates and total escrow volume in JSON format."""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # 1. Total Users Breakdown
    cursor.execute("SELECT role, COUNT(*) as count FROM users GROUP BY role")
    users_by_role = {row['role']: row['count'] for row in cursor.fetchall()}

    # 2. Escrow Volume (Summing active, successful, and disputed payouts)
    cursor.execute("SELECT SUM(CAST(offer AS REAL)) as total_volume FROM loads WHERE payment_status IN ('paid', 'dispute_under_review', 'dispute_won', 'dispute_lost')")
    volume_row = cursor.fetchone()
    total_volume = volume_row['total_volume'] if volume_row['total_volume'] else 0

    # 3. Dispute Metrics
    cursor.execute("SELECT COUNT(*) as total FROM loads WHERE payment_status IN ('paid', 'disputed', 'dispute_under_review', 'dispute_won', 'dispute_lost')")
    total_completed_loads = cursor.fetchone()['total']

    cursor.execute("SELECT COUNT(*) as total FROM loads WHERE payment_status IN ('disputed', 'dispute_under_review', 'dispute_won', 'dispute_lost')")
    total_disputes = cursor.fetchone()['total']

    dispute_rate = (total_disputes / total_completed_loads * 100) if total_completed_loads > 0 else 0

    conn.close()

    return jsonify({
        'users': users_by_role,
        'total_escrow_volume_usd': total_volume,
        'total_completed_loads': total_completed_loads,
        'total_disputes': total_disputes,
        'dispute_rate_percentage': round(dispute_rate, 2)
    })