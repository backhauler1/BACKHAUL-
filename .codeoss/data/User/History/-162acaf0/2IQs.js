const express = require('express');
const pool = require('./db');
const { protect, authorize } = require('./auth');
const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');

const router = express.Router();

// Initialize the Mapbox Geocoding client
const geocodingService = mbxGeocoding({ accessToken: process.env.MAPBOX_TOKEN });

/**
 * POST /api/trucks/post
 * Creates a new truck listing. This route is protected and requires authentication.
 */
router.post('/post', protect, async (req, res) => {
    // If you create a 'driver' role, you can lock this down further:
    // router.post('/post', protect, authorize('driver', 'admin'), async (req, res) => { ... });

    const {
        name,
        description,
        vehicleClass,
        currentLocation, // The address string
        isAvailable,
    } = req.body;

    const ownerId = req.user.id; // From the `protect` middleware

    // Driver must be verified to post a truck.
    if (!req.user.id_verified) {
        return res.status(403).json({ message: 'You must verify your identity before posting a truck.' });
    }

    // 1. Basic Validation
    if (!name || !currentLocation) {
        return res.status(400).json({ message: 'Truck name and current location are required.' });
    }

    try {
        // 2. Geocode the current location address to get coordinates
        const geoResponse = await geocodingService.forwardGeocode({
            query: currentLocation,
            limit: 1,
        }).send();

        if (!geoResponse || !geoResponse.body || !geoResponse.body.features || geoResponse.body.features.length === 0) {
            return res.status(400).json({ message: 'Could not find coordinates for the specified location.' });
        }

        const [currentLng, currentLat] = geoResponse.body.features[0].center;

        // 3. Insert the new truck into the database
        // NOTE: This requires a `trucks` table with these columns.
        const newTruckQuery = await pool.query(
            `INSERT INTO trucks (owner_id, name, description, vehicle_class, current_location_address, is_available, current_lng, current_lat)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [ownerId, name, description, vehicleClass, currentLocation, isAvailable ?? true, currentLng, currentLat]
        );

        const newTruck = newTruckQuery.rows[0];

        // 4. Send a success response
        res.status(201).json({
            message: 'Truck posted successfully!',
            data: newTruck,
        });

    } catch (error) {
        console.error('Post Truck Error:', error);
        if (error.code === '23503') { // Foreign key violation
            return res.status(400).json({ message: 'Invalid owner ID.' });
        }
        res.status(500).json({ message: 'Internal server error while posting truck.' });
    }
});

module.exports = router;