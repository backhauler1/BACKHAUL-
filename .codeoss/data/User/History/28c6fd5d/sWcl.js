const express = require('express');
const router = express.Router();
const db = require('./db'); // Assuming you have a centralized db connection module
const { authenticateUser } = require('./middleware/auth'); // Placeholder for auth middleware

/**
 * @route   GET /api/loads/:id/tracking
 * @desc    Get destination and live truck location for a specific load.
 * @access  Private (Shipper/User)
 *
 * This endpoint is called by the shipper's UI to populate the tracking map.
 */
router.get('/:id/tracking', authenticateUser, async (req, res) => {
    const { id } = req.params;

    try {
        // This query joins Loads with Trucks to get both the destination and current location
        const sql = `
            SELECT 
                l."id" AS "load_id",
                l."deliveryLatitude" AS "destination_lat",
                l."deliveryLongitude" AS "destination_lng",
                t."id" AS "truck_id",
                t."current_latitude" AS "truck_lat",
                t."current_longitude" AS "truck_lng",
                t."last_location_update"
            FROM "Loads" l
            LEFT JOIN "Trucks" t ON l."assigned_truck_id" = t."id"
            WHERE l."id" = $1;
        `;

        const result = await db.query(sql, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Load not found.' });
        }

        // Security check: Ensure the user requesting this load is authorized to see it.
        // This logic would depend on your application's ownership rules.
        // For example: if (result.rows[0].shipperId !== req.user.id) { return res.status(403).json(...) }

        res.status(200).json(result.rows[0]);

    } catch (err) {
        console.error('Error fetching tracking data:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;