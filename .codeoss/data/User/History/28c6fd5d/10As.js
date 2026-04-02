const express = require('express');
const pool = require('./db');
const { protect, authorize } = require('./auth');
const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const multer = require('multer');
const { z } = require('zod');
const validate = require('./validate');
const { numericParamSchema } = require('./commonSchemas');
const sendEmail = require('./email');

const router = express.Router();

// Initialize multer for parsing multipart/form-data (required since the frontend sends FormData)
const upload = multer();

// Initialize the Mapbox Geocoding client
const geocodingService = mbxGeocoding({ accessToken: process.env.MAPBOX_TOKEN });

const loadSchema = z.object({
    title: z.string({ required_error: 'Title is required.' }).min(1, 'Title is required.'),
    description: z.string().optional(),
    pickupAddress: z.string({ required_error: 'Pickup address is required.' }).min(1, 'Pickup address is required.'),
    deliveryAddress: z.string({ required_error: 'Delivery address is required.' }).min(1, 'Delivery address is required.'),
    pickupDate: z.string().optional(),
    deliveryDate: z.string().optional(),
    requiredVehicleClass: z.string().optional(),
    weight: z.coerce.number().positive('Weight must be a positive number.').optional()
});

// Schema for the /find search criteria
const findLoadsSchema = z.object({
    'backhaul-origin': z.string().optional(),
    'backhaul-destination': z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional()
}).passthrough();

const paginationQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(50).default(10)
});

const etaSchema = z.object({
    eta: z.string({ required_error: 'ETA is required.' }).min(1, 'ETA is required.')
});

const rateSchema = z.object({
    rating: z.coerce.number().int().min(1, 'Rating must be at least 1 star.').max(5, 'Rating cannot exceed 5 stars.'),
    targetUserId: z.coerce.number().int().positive('Invalid target user ID.')
});

/**
 * POST /api/loads/post
 * Creates a new load listing. This route is protected and requires authentication.
 */
router.post('/post', protect, validate({ body: loadSchema }), async (req, res) => {
    // If you create a 'shipper' role, you can lock this down further like this:
    // router.post('/post', protect, authorize('shipper', 'admin'), async (req, res) => { ... });

    const {
        title,
        description,
        pickupAddress,
        deliveryAddress,
        pickupDate,
        deliveryDate,
        requiredVehicleClass,
        weight, // Assuming you might add weight later
    } = req.body;

    const ownerId = req.user.id; // From the `protect` middleware

    try {
        // 2. Geocode the pickup address to get coordinates for the map
        const geoResponse = await geocodingService.forwardGeocode({
            query: pickupAddress,
            limit: 1,
        }).send();

        if (!geoResponse || !geoResponse.body || !geoResponse.body.features || geoResponse.body.features.length === 0) {
            return res.status(400).json({ message: 'Could not find coordinates for the specified pickup address.' });
        }

        const [pickupLng, pickupLat] = geoResponse.body.features[0].center;

        // 3. Insert the new load into the database
        // NOTE: This assumes your `loads` table has these columns.
        // The `pickup_location` column is ideal for PostGIS, but here we use separate lng/lat columns.
        const newLoadQuery = await pool.query(
            `INSERT INTO loads (owner_id, title, description, pickup_address, delivery_address, pickup_date, delivery_date, required_vehicle_class, weight, pickup_lng, pickup_lat)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`,
            [ownerId, title, description, pickupAddress, deliveryAddress, pickupDate, deliveryDate, requiredVehicleClass, weight, pickupLng, pickupLat]
        );

        const newLoad = newLoadQuery.rows[0];

        // 4. Send a success response
        res.status(201).json({
            message: 'Load posted successfully!',
            data: newLoad,
        });

    } catch (error) {
        console.error('Post Load Error:', error);
        if (error.code === '23503') { // Foreign key violation
            return res.status(400).json({ message: 'Invalid owner ID.' });
        }
        res.status(500).json({ message: 'Internal server error while posting load.' });
    }
});

/**
 * POST /api/loads/find
 * Searches for available loads based on form criteria (like dates).
 * Uses upload.none() because the frontend sends FormData.
 */
router.post('/find', upload.none(), validate({ body: findLoadsSchema, query: paginationQuerySchema }), async (req, res) => {
    const { startDate, endDate } = req.body;
    const { page, limit } = req.query;
    const offset = (page - 1) * limit;

    try {
        let queryStr = `SELECT * FROM loads WHERE 1=1`;
        const queryParams = [];
        let paramIndex = 1;

        // Apply Start Date Filter safely via parameterized query
        if (startDate) {
            queryStr += ` AND pickup_date >= $${paramIndex}`;
            queryParams.push(startDate);
            paramIndex++;
        }

        // Apply End Date Filter safely via parameterized query
        if (endDate) {
            queryStr += ` AND pickup_date <= $${paramIndex}`;
            queryParams.push(endDate);
            paramIndex++;
        }

        // Calculate total items for pagination
        const countQuery = `SELECT COUNT(*) FROM (${queryStr}) as total`;
        const { rows: countRows } = await pool.query(countQuery, queryParams);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit);

        // Append ordering, limit, and offset to the final query
        queryStr += ` ORDER BY pickup_date ASC NULLS LAST LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        queryParams.push(limit, offset);

        const { rows: loads } = await pool.query(queryStr, queryParams);

        res.status(200).json({
            data: loads,
            pagination: { currentPage: page, totalPages, totalItems }
        });
    } catch (error) {
        console.error('Find Loads Error:', error);
        res.status(500).json({ message: 'Internal server error while searching for loads.' });
    }
});

/**
 * GET /api/loads/assigned
 * Fetches the loads currently assigned to the authenticated driver.
 */
router.get('/assigned', protect, async (req, res) => {
    const driverId = req.user.id;

    try {
        const queryStr = `
            SELECT id, title, description, pickup_address, delivery_address, 
                   pickup_date, delivery_date, status, accepted_at, eta
            FROM loads 
            WHERE driver_id = $1 AND status IN ('assigned', 'en_route')
            ORDER BY pickup_date ASC
        `;
        
        const { rows: loads } = await pool.query(queryStr, [driverId]);

        res.status(200).json({ data: loads });
    } catch (error) {
        console.error('Fetch Assigned Loads Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching assigned loads.' });
    }
});

/**
 * GET /api/loads/posted
 * Fetches the loads posted by the authenticated shipper, including current ETA and status.
 */
router.get('/posted', protect, async (req, res) => {
    const ownerId = req.user.id;

    try {
        const queryStr = `
            SELECT id, title, description, pickup_address, delivery_address, 
                   pickup_date, delivery_date, status, eta, driver_id
            FROM loads 
            WHERE owner_id = $1
            ORDER BY pickup_date DESC
        `;
        
        const { rows: loads } = await pool.query(queryStr, [ownerId]);

        res.status(200).json({ data: loads });
    } catch (error) {
        console.error('Fetch Posted Loads Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching posted loads.' });
    }
});

/**
 * GET /api/loads/admin/cancellations/export
 * Exports the cancellation logs to a CSV file, applying any active filters.
 */
router.get('/admin/cancellations/export', protect, authorize('admin'), validate({ query: z.object({ email: z.string().optional() }) }), async (req, res) => {
    const { email } = req.query;

    try {
        let queryStr = `
            SELECT cl.id, cl.load_id, cl.load_title, cl.reason, cl.cancelled_at, u.name as user_name, u.email as user_email
            FROM cancellation_logs cl
            LEFT JOIN users u ON cl.user_id = u.id
        `;
        const queryParams = [];

        // Apply the same email filter as the main view
        if (email) {
            queryStr += ` WHERE u.email ILIKE $1`;
            queryParams.push(`%${email}%`);
        }

        queryStr += ` ORDER BY cl.cancelled_at DESC`;

        const { rows: logs } = await pool.query(queryStr, queryParams);

        // Generate CSV content manually
        const csvHeader = 'Log ID,Date & Time,Load ID,Load Title,User Name,User Email,Reason Given\n';
        const csvRows = logs.map(log => {
            // Helper to escape commas and double quotes inside CSV fields
            const escapeCSV = (value) => {
                if (value == null) return '""';
                return `"${String(value).replace(/"/g, '""')}"`;
            };
            return [escapeCSV(log.id), escapeCSV(new Date(log.cancelled_at).toLocaleString()), escapeCSV(log.load_id), escapeCSV(log.load_title), escapeCSV(log.user_name), escapeCSV(log.user_email), escapeCSV(log.reason)].join(',');
        });

        const csvContent = csvHeader + csvRows.join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="cancellation_logs.csv"');
        res.status(200).send(csvContent);
    } catch (error) {
        console.error('Export Cancellation Logs Error:', error);
        res.status(500).json({ message: 'Internal server error while exporting cancellation logs.' });
    }
});

/**
 * GET /api/loads/admin/cancellations
 * Fetches the cancellation logs for admin review.
 */
router.get('/admin/cancellations', protect, authorize('admin'), validate({ query: paginationQuerySchema.extend({ email: z.string().optional() }) }), async (req, res) => {
    const { page, limit, email } = req.query;
    const offset = (page - 1) * limit;

    try {
        let countQuery = 'SELECT COUNT(*) FROM cancellation_logs cl LEFT JOIN users u ON cl.user_id = u.id';
        let queryStr = `
            SELECT cl.id, cl.load_id, cl.load_title, cl.reason, cl.cancelled_at, u.name as user_name, u.email as user_email
            FROM cancellation_logs cl
            LEFT JOIN users u ON cl.user_id = u.id
        `;

        const countParams = [];
        const queryParams = [];
        let paramIndex = 1;

        // If an email search term is provided, filter using a case-insensitive partial match
        if (email) {
            const whereClause = ` WHERE u.email ILIKE $1`;
            countQuery += whereClause;
            queryStr += whereClause;
            countParams.push(`%${email}%`);
            queryParams.push(`%${email}%`);
            paramIndex++;
        }

        const { rows: countRows } = await pool.query(countQuery, countParams);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit) || 1; // Fallback to 1 if 0 items

        queryStr += ` ORDER BY cl.cancelled_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        queryParams.push(limit, offset);

        const { rows: logs } = await pool.query(queryStr, queryParams);

        res.status(200).json({
            data: logs,
            pagination: { currentPage: page, totalPages, totalItems }
        });
    } catch (error) {
        console.error('Fetch Cancellation Logs Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching cancellation logs.' });
    }
});

/**
 * PATCH /api/loads/:id/eta
 * Allows a driver to update the Estimated Time of Arrival (ETA) for a load they are carrying.
 * Triggers an automated email to the shipper.
 */
router.patch('/:id/eta', protect, validate({ params: numericParamSchema('id'), body: etaSchema }), async (req, res) => {
    const loadId = req.params.id;
    const { eta } = req.body;

    try {
        // 1. Update the ETA in the database and return the load details
        const updateQuery = `
            UPDATE loads 
            SET eta = $1 
            WHERE id = $2 
            RETURNING title, owner_id
        `;
        const { rows } = await pool.query(updateQuery, [eta, loadId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Load not found.' });
        }

        const updatedLoad = rows[0];

        // 2. Fetch the shipper's (owner's) email address
        const userQuery = await pool.query('SELECT email, name FROM users WHERE id = $1', [updatedLoad.owner_id]);
        const shipper = userQuery.rows[0];

        // 3. Send a notification email to the shipper
        if (shipper) {
            const formattedEta = new Date(eta).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
            const emailOptions = {
                to: shipper.email,
                subject: `ETA Update for Load: "${updatedLoad.title}"`,
                text: `Hi ${shipper.name},\n\nThe driver for your load "${updatedLoad.title}" has updated their ETA to: ${formattedEta}.\n\nPlease ensure your facility is ready to receive them.\n\nBest,\nYour App Team`,
                html: `
                    <div style="font-family: sans-serif; line-height: 1.6;">
                        <h2>Driver ETA Updated</h2>
                        <p>Hi ${shipper.name},</p>
                        <p>The driver for your load <strong>"${updatedLoad.title}"</strong> has updated their Estimated Time of Arrival.</p>
                        <p><strong>New ETA:</strong> ${formattedEta}</p>
                        <p>Please ensure your facility is ready to receive them.</p>
                        <br>
                        <p>Best,</p>
                        <p><strong>Your App Team</strong></p>
                    </div>
                `
            };
            await sendEmail(emailOptions);
        }

        res.status(200).json({ message: 'ETA updated successfully and shipper notified.' });
    } catch (error) {
        console.error('Update ETA Error:', error);
        res.status(500).json({ message: 'Internal server error while updating ETA.' });
    }
});

/**
 * PATCH /api/loads/:id/start-trip
 * Allows a driver to indicate they are on their way to pick up the load.
 * Triggers an automated email to the shipper.
 */
router.patch('/:id/start-trip', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const driverId = req.user.id; // The authenticated driver

    try {
        // 1. Update the load status in the database to indicate the driver is on their way.
        // (Note: Adjust the column names 'status' and 'driver_id' to match your actual database schema)
        const updateQuery = `
            UPDATE loads 
            SET status = 'en_route', driver_id = $1 
            WHERE id = $2 
            RETURNING title, owner_id
        `;
        const { rows } = await pool.query(updateQuery, [driverId, loadId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Load not found or could not be updated.' });
        }

        const updatedLoad = rows[0];

        // 2. Fetch the shipper's (owner's) email address
        const userQuery = await pool.query('SELECT email, name FROM users WHERE id = $1', [updatedLoad.owner_id]);
        const shipper = userQuery.rows[0];

        // 3. Send a notification email to the shipper
        if (shipper) {
            const emailOptions = {
                to: shipper.email,
                subject: `Driver En Route: "${updatedLoad.title}"`,
                text: `Hi ${shipper.name},\n\nThe driver for your load "${updatedLoad.title}" has started their journey and is currently on their way to the pickup location.\n\nBest,\nYour App Team`,
                html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Driver En Route</h2><p>Hi ${shipper.name},</p><p>The driver for your load <strong>"${updatedLoad.title}"</strong> has started their journey and is currently on their way to the pickup location.</p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
            };
            await sendEmail(emailOptions);
        }

        res.status(200).json({ message: 'Trip started successfully and shipper notified.' });
    } catch (error) {
        console.error('Start Trip Error:', error);
        res.status(500).json({ message: 'Internal server error while starting trip.' });
    }
});

/**
 * PATCH /api/loads/:id/undo-start-trip
 * Reverts the load status if the driver accidentally started the trip.
 */
router.patch('/:id/undo-start-trip', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const driverId = req.user.id; // Ensure only the assigned driver can undo it

    try {
        // Revert status to 'assigned' (adjust if your schema uses a different pre-trip status)
        const updateQuery = `
            UPDATE loads 
            SET status = 'assigned' 
            WHERE id = $1 AND driver_id = $2 AND status = 'en_route'
            RETURNING title, owner_id
        `;
        const { rows } = await pool.query(updateQuery, [loadId, driverId]);

        if (rows.length === 0) {
            return res.status(400).json({ message: 'Could not undo. Trip might not be in progress or you do not have permission.' });
        }

        // Note: We intentionally skip sending an "Oops, false alarm" email here 
        // to avoid spamming the shipper. We just quietly fix the system state.
        
        res.status(200).json({ message: 'Trip start undone successfully.' });
    } catch (error) {
        console.error('Undo Start Trip Error:', error);
        res.status(500).json({ message: 'Internal server error while undoing trip.' });
    }
});

/**
 * PATCH /api/loads/:id/accept
 * Allows a driver to accept an available load.
 */
router.patch('/:id/accept', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const driverId = req.user.id; // The authenticated driver

    try {
        // 1. Update the load status to 'assigned', but ONLY if it is currently available.
        // Using 'IS NULL OR status = 'available'' depending on your default schema state.
        const updateQuery = `
            UPDATE loads 
            SET status = 'assigned', driver_id = $1, accepted_at = NOW()
            WHERE id = $2 AND (status IS NULL OR status = 'available')
            RETURNING title, owner_id, accepted_at
        `;
        const { rows } = await pool.query(updateQuery, [driverId, loadId]);

        if (rows.length === 0) {
            return res.status(400).json({ message: 'Load is no longer available or has already been accepted.' });
        }

        const updatedLoad = rows[0];

        // 2. Fetch shipper info to send a confirmation email
        const userQuery = await pool.query('SELECT email, name FROM users WHERE id = $1', [updatedLoad.owner_id]);
        const shipper = userQuery.rows[0];

        // Fetch the driver's info to send them a confirmation and grace period warning
        const driverQuery = await pool.query('SELECT email, name FROM users WHERE id = $1', [driverId]);
        const driver = driverQuery.rows[0];

        if (shipper) {
            const emailOptions = {
                to: shipper.email,
                subject: `Load Accepted: "${updatedLoad.title}"`,
                text: `Hi ${shipper.name},\n\nGreat news! A driver has officially accepted your load "${updatedLoad.title}".\n\nNote: The driver has a 15-minute grace period to back out without penalty. We will notify you immediately if they cancel.\n\nBest,\nYour App Team`,
                html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Load Accepted!</h2><p>Hi ${shipper.name},</p><p>Great news! A driver has officially accepted your load <strong>"${updatedLoad.title}"</strong>.</p><p><em>Note: The driver has a 15-minute grace period to back out without penalty. We will notify you immediately if they cancel.</em></p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
            };
            await sendEmail(emailOptions);
        }

        if (driver) {
            const emailOptions = {
                to: driver.email,
                subject: `You Accepted Load: "${updatedLoad.title}"`,
                text: `Hi ${driver.name},\n\nYou have successfully accepted the load "${updatedLoad.title}".\n\nYou have a 15-minute grace period to cancel this acceptance without penalty. If you cancel after 15 minutes, a penalty will be applied to your account.\n\nBest,\nYour App Team`,
                html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Load Accepted</h2><p>Hi ${driver.name},</p><p>You have successfully accepted the load <strong>"${updatedLoad.title}"</strong>.</p><p><strong>Important:</strong> You have a 15-minute grace period to cancel this acceptance without penalty. If you cancel after 15 minutes, a penalty will be applied to your account.</p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
            };
            await sendEmail(emailOptions);
        }

        res.status(200).json({ message: 'Load accepted successfully!', data: { accepted_at: updatedLoad.accepted_at } });
    } catch (error) {
        console.error('Accept Load Error:', error);
        res.status(500).json({ message: 'Internal server error while accepting load.' });
    }
});

/**
 * PATCH /api/loads/:id/cancel-acceptance
 * Allows a driver to back out of a load they previously accepted.
 */
router.patch('/:id/cancel-acceptance', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const driverId = req.user.id;

    try {
        // 1. Fetch load details to verify ownership and check the grace period
        const checkQuery = `
            SELECT accepted_at, title, owner_id 
            FROM loads 
            WHERE id = $1 AND driver_id = $2 AND status = 'assigned'
        `;
        const { rows: checkRows } = await pool.query(checkQuery, [loadId, driverId]);

        if (checkRows.length === 0) {
            return res.status(400).json({ message: 'Cannot cancel. You either do not own this load, or the trip has already started.' });
        }

        const loadInfo = checkRows[0];

        // 2. Check the 15-minute grace period
        let penaltyApplied = false;
        if (loadInfo.accepted_at) {
            const acceptedTime = new Date(loadInfo.accepted_at);
            const now = new Date();
            const diffInMinutes = (now - acceptedTime) / 1000 / 60;
            
            if (diffInMinutes > 15) {
                penaltyApplied = true;
                // Apply penalty logic: increment a penalty counter on the user.
                // This can later be used to suspend users or lower their driver rating.
                await pool.query('UPDATE users SET penalty_count = COALESCE(penalty_count, 0) + 1 WHERE id = $1', [driverId]);
            }
        }

        // 3. Revert status to 'available', remove driver assignment, and clear accepted_at
        const updateQuery = `
            UPDATE loads 
            SET status = 'available', driver_id = NULL, accepted_at = NULL 
            WHERE id = $1 AND driver_id = $2 AND status = 'assigned'
        `;
        await pool.query(updateQuery, [loadId, driverId]);

        // 4. Notify the shipper that the load is back on the market
        const userQuery = await pool.query('SELECT email, name FROM users WHERE id = $1', [loadInfo.owner_id]);
        const shipper = userQuery.rows[0];

        if (shipper) {
            const emailOptions = {
                to: shipper.email,
                subject: `ALERT: Driver Canceled - "${loadInfo.title}"`,
                text: `Hi ${shipper.name},\n\nThe driver assigned to your load "${loadInfo.title}" has canceled their acceptance.\n\nYour load has automatically been placed back on the open market for other drivers to accept.\n\nBest,\nYour App Team`,
                html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Driver Canceled</h2><p>Hi ${shipper.name},</p><p>The driver assigned to your load <strong>"${loadInfo.title}"</strong> has canceled their acceptance.</p><p>Your load has automatically been placed back on the open market for other drivers to accept.</p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
            };
            await sendEmail(emailOptions);
        }
        
        let responseMessage = 'Acceptance canceled. The load is back on the market.';
        if (penaltyApplied) {
            responseMessage += ' A penalty has been applied to your account for canceling after the 15-minute grace period.';
        }
        
        res.status(200).json({ message: responseMessage });
    } catch (error) {
        console.error('Cancel Acceptance Error:', error);
        res.status(500).json({ message: 'Internal server error while canceling acceptance.' });
    }
});

/**
 * DELETE /api/loads/:id
 * Allows a shipper to cancel (delete) an available load they posted.
 */
router.delete('/:id', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const ownerId = req.user.id;
    const reason = req.query.reason || 'No reason provided';

    try {
        // Use a transaction to ensure both the deletion and the logging succeed or fail together
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            const deleteQuery = `
                DELETE FROM loads 
                WHERE id = $1 AND owner_id = $2 AND (status IS NULL OR status = 'available')
                RETURNING id, title
            `;
            const { rows } = await client.query(deleteQuery, [loadId, ownerId]);
    
            if (rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Cannot cancel this load. It may already be assigned or you do not have permission.' });
            }
            
            const deletedLoad = rows[0];
    
            // Insert the cancellation reason into the logs table.
            const logQuery = `
                INSERT INTO cancellation_logs (load_id, load_title, user_id, reason, cancelled_at) 
                VALUES ($1, $2, $3, $4, NOW())
            `;
            await client.query(logQuery, [loadId, deletedLoad.title, ownerId, reason]);
    
            await client.query('COMMIT');
            res.status(200).json({ message: 'Load successfully cancelled and removed from the market.' });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Cancel Load Error:', error);
        res.status(500).json({ message: 'Internal server error while canceling load.' });
    }
});

/**
 * PATCH /api/loads/:id/arrived
 * Driver marks that they have arrived at the pickup location.
 */
router.patch('/:id/arrived', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const driverId = req.user.id;

    try {
        const updateQuery = `
            UPDATE loads 
            SET status = 'arrived', arrived_at = NOW()
            WHERE id = $1 AND driver_id = $2 AND status = 'en_route'
            RETURNING title
        `;
        const { rows } = await pool.query(updateQuery, [loadId, driverId]);

        if (rows.length === 0) {
            return res.status(400).json({ message: 'Could not update status. Load might not be in progress or you do not have permission.' });
        }

        res.status(200).json({ message: 'Status updated to Arrived.' });
    } catch (error) {
        console.error('Arrived Status Error:', error);
        res.status(500).json({ message: 'Internal server error while updating status.' });
    }
});

/**
 * PATCH /api/loads/:id/completed-loading
 * Driver marks that they have completed loading and are leaving the pickup location.
 */
router.patch('/:id/completed-loading', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const driverId = req.user.id;

    try {
        const updateQuery = `
            UPDATE loads 
            SET status = 'loading_completed'
            WHERE id = $1 AND driver_id = $2 AND status = 'arrived'
            RETURNING title
        `;
        const { rows } = await pool.query(updateQuery, [loadId, driverId]);

        if (rows.length === 0) {
            return res.status(400).json({ message: 'Could not update status. Load must be in "arrived" state.' });
        }

        res.status(200).json({ message: 'Status updated to Loading Completed.' });
    } catch (error) {
        console.error('Completed Loading Status Error:', error);
        res.status(500).json({ message: 'Internal server error while updating status.' });
    }
});

/**
 * POST /api/loads/:id/rate
 * Allows a driver or shipper to rate the other party after completion.
 */
router.post('/:id/rate', protect, validate({ params: numericParamSchema('id'), body: rateSchema }), async (req, res) => {
    const loadId = req.params.id;
    const currentUserId = req.user.id;
    const { rating, targetUserId } = req.body;

    try {
        // 1. Verify load exists
        const loadQuery = await pool.query('SELECT owner_id, driver_id, status FROM loads WHERE id = $1', [loadId]);
        const load = loadQuery.rows[0];

        if (!load) return res.status(404).json({ message: 'Load not found.' });

        // 2. Verify current user is associated with the load
        if (load.owner_id !== currentUserId && load.driver_id !== currentUserId) {
            return res.status(403).json({ message: 'You are not authorized to rate this load.' });
        }

        if (load.owner_id !== targetUserId && load.driver_id !== targetUserId) {
            return res.status(400).json({ message: 'Target user is not associated with this load.' });
        }
        
        // 3. Calculate and update the target user's new average rating
        // Casting $1 to numeric prevents integer division truncation in PostgreSQL
        const updateQuery = `
            UPDATE users 
            SET rating = ((rating * rating_count) + $1::numeric) / (rating_count + 1),
                rating_count = rating_count + 1
            WHERE id = $2
        `;
        await pool.query(updateQuery, [rating, targetUserId]);

        res.status(200).json({ message: 'Rating submitted successfully!' });
    } catch (error) {
        console.error('Submit Rating Error:', error);
        res.status(500).json({ message: 'Internal server error while submitting rating.' });
    }
});

module.exports = router;