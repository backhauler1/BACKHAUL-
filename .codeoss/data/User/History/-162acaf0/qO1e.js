const express = require('express');
const router = express.Router();
const db = require('./db'); // Assuming you have a centralized db connection module
const { authenticateDriver } = require('./middleware/auth'); // Placeholder for auth middleware

/**
 * @route   PATCH /api/trucks/:id/location
 * @desc    Update a truck's current GPS location.
 * @access  Private (Driver only)
 *
 * This endpoint would be called by the driver's mobile device periodically.
 */
router.patch('/:id/location', authenticateDriver, async (req, res) => {
    const { latitude, longitude } = req.body;
    const { id } = req.params;

    // Basic validation
    if (latitude == null || longitude == null) {
        return res.status(400).json({ error: 'Latitude and longitude are required.' });
    }

    // Security check: Ensure the authenticated driver is updating their own truck
    // Your `authenticateDriver` middleware should add user/driver info to `req`.
    if (req.driver.truckId !== parseInt(id, 10)) {
        return res.status(403).json({ error: 'Forbidden: You can only update your own truck location.' });
    }

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const sql = `
            UPDATE "Trucks"
            SET 
                "current_latitude" = $1,
                "current_longitude" = $2,
                "last_location_update" = NOW()
            WHERE "id" = $3
            RETURNING "id", "last_location_update";
        `;
        const result = await client.query(sql, [latitude, longitude, id]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Truck not found.' });
        }

        // Insert the breadcrumb into the history table
        const historySql = `
            INSERT INTO truck_location_history (truck_id, latitude, longitude)
            VALUES ($1, $2, $3);
        `;
        await client.query(historySql, [id, latitude, longitude]);

        await client.query('COMMIT');
        res.status(200).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error updating truck location:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        client.release();
    }
});

module.exports = router;