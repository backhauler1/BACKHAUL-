const express = require('express');
const router = express.Router();
const pool = require('./db');
const { protect } = require('./auth'); 

/**
 * @route   GET /api/loads/:id/tracking
 * @desc    Get destination and live truck location for a specific load.
 * @access  Private (Shipper/User)
 *
 * This endpoint is called by the shipper's UI to populate the tracking map.
 */
router.get('/:id/tracking', protect, async (req, res) => {
    const { id } = req.params;

    try {
        // This query joins Loads with Trucks to get both the destination and current location
        const sql = `
            SELECT 
                l.id AS load_id,
                l.owner_id,
                l."deliveryLatitude" AS destination_lat,
                l."deliveryLongitude" AS destination_lng,
                t.id AS truck_id,
                t.current_latitude AS truck_lat,
                t.current_longitude AS truck_lng,
                t.last_location_update
            FROM loads l
            LEFT JOIN trucks t ON l.driver_id = t.owner_id
            WHERE l.id = $1;
        `;

        const result = await pool.query(sql, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Load not found.' });
        }

        // Security check: Ensure the user requesting this load is the owner/shipper.
        if (result.rows[0].owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Forbidden: You can only track your own loads.' });
        }

        const trackingData = result.rows[0];

        // Fetch historical breadcrumbs to draw the route line
        const historySql = `
            SELECT longitude, latitude
            FROM truck_location_history
            WHERE truck_id = $1
            ORDER BY recorded_at ASC;
        `;
        const historyResult = await pool.query(historySql, [trackingData.truck_id]);
        
        // Format the breadcrumbs as a GeoJSON LineString (requires at least 2 points to draw a line)
        if (historyResult.rows.length > 1) {
            trackingData.routeGeometry = {
                type: "Feature",
                geometry: {
                    type: "LineString",
                    // Mapbox expects coordinates in [longitude, latitude] order
                    coordinates: historyResult.rows.map(row => [parseFloat(row.longitude), parseFloat(row.latitude)])
                }
            };
        }

        res.status(200).json(trackingData);

    } catch (err) {
        console.error('Error fetching tracking data:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;