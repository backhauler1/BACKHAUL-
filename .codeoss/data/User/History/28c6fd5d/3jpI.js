const express = require('express');
const router = express.Router();
const pool = require('./db');
const redisClient = require('./redis');
const { protect, authorize } = require('./auth');
const { z } = require('zod');
const validate = require('./validate');
const { numericParamSchema } = require('./commonSchemas');
const sendEmail = require('./email');
const { geocodeAddress } = require('./geocodingService');
const crypto = require('crypto');
const { s3Client, getObjectStream, getS3KeyFromUrl } = require('./s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { uploadSignedBol } = require('./uploads');

const multer = require('multer');

// Initialize multer for parsing multipart/form-data (required since the frontend sends FormData)
const upload = multer();

const loadSchema = z.object({
    title: z.string({ required_error: 'Title is required.' }).min(1, 'Title is required.'),
    description: z.string().optional(),
    pickupAddress: z.string({ required_error: 'Pickup address is required.' }).min(1, 'Pickup address is required.'),
    deliveryAddress: z.string({ required_error: 'Delivery address is required.' }).min(1, 'Delivery address is required.'),
    pickupDate: z.string().optional(),
    deliveryDate: z.string().optional(),
    requiredVehicleClass: z.string().optional(),
    weight: z.coerce.number().positive('Weight must be a positive number.').optional(),
    rate: z.coerce.number().positive('Rate must be a positive number.').optional(),
});

// Schema for the /find search criteria
const findLoadsSchema = z.object({
    'backhaul-origin': z.string().optional(),
    'backhaul-destination': z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    truckType: z.string().optional(),
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
    targetUserId: z.coerce.number().int().positive('Invalid target user ID.'),
    review: z.string().max(1000, 'Review cannot exceed 1000 characters.').optional(),
});

const updateRateSchema = z.object({
    rating: z.coerce.number().int().min(1, 'Rating must be at least 1 star.').max(5, 'Rating cannot exceed 5 stars.'),
    review: z.string().max(1000, 'Review cannot exceed 1000 characters.').optional(),
});

const bidSchema = z.object({
    bidAmount: z.coerce.number().positive('Bid amount must be a positive number.'),
    notes: z.string().max(500, 'Notes cannot exceed 500 characters.').optional(),
});

/**
 * POST /api/loads/post
 * Creates a new load listing. This route is protected and requires authentication.
 */
router.post('/post', protect, upload.single('bolDocument'), validate({ body: loadSchema }), async (req, res) => {
    const {
        title,
        description,
        pickupAddress,
        deliveryAddress,
        pickupDate,
        deliveryDate,
        requiredVehicleClass,
        weight, 
        rate,
    } = req.body;

    const bolUrl = req.file ? req.file.location : null;
    const ownerId = req.user.id; 

    try {
        // 2. Geocode the pickup address using the resilient service
        const coordinates = await geocodeAddress(pickupAddress);

        // Gracefully handle cases where geocoding is unavailable or returns no result
        const pickupLng = coordinates ? coordinates[0] : null;
        const pickupLat = coordinates ? coordinates[1] : null;

        // 3. Insert the new load into the database
        const newLoadQuery = await pool.query(
            `INSERT INTO loads (owner_id, title, description, pickup_address, delivery_address, pickup_date, delivery_date, required_vehicle_class, weight, rate, bol_url, pickup_lng, pickup_lat)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING *`,
            [ownerId, title, description, pickupAddress, deliveryAddress, pickupDate, deliveryDate, requiredVehicleClass, weight, rate, bolUrl, pickupLng, pickupLat]
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
    const { startDate, endDate, truckType } = req.body;
    const { page, limit } = req.query;
    const offset = (page - 1) * limit;

    const cacheKey = `loads:find:${crypto.createHash('md5').update(JSON.stringify(req.body) + JSON.stringify(req.query)).digest('hex')}`;

    try {
        // 1. Try to get data from cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.status(200).json(JSON.parse(cachedData));
        }

        // 2. If cache miss, query the database
        let baseQuery = `FROM loads WHERE (status IS NULL OR status = 'available')`;
        const queryParams = [];
        let paramIndex = 1;

        if (startDate) {
            baseQuery += ` AND pickup_date >= $${paramIndex}`;
            queryParams.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            baseQuery += ` AND pickup_date <= $${paramIndex}`;
            queryParams.push(endDate);
            paramIndex++;
        }

        if (truckType) {
            baseQuery += ` AND required_vehicle_class = $${paramIndex}`;
            queryParams.push(truckType);
            paramIndex++;
        }

        // Calculate total items for pagination
        const countQuery = `SELECT COUNT(*) ${baseQuery}`;
        const { rows: countRows } = await pool.query(countQuery, queryParams);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit);

        // Append ordering, limit, and offset to the final query
        const queryStr = `SELECT * ${baseQuery} ORDER BY pickup_date ASC NULLS LAST LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        const finalQueryParams = [...queryParams, limit, offset];

        const { rows: loads } = await pool.query(queryStr, finalQueryParams);

        const responsePayload = {
            data: loads,
            pagination: { currentPage: page, totalPages, totalItems }
        };

        // 3. Cache the result in Redis for 1 minute (60 seconds)
        await redisClient.setEx(cacheKey, 60, JSON.stringify(responsePayload));

        res.status(200).json(responsePayload);
    } catch (error) {
        console.error('Find Loads Error:', error);
        // Fallback to DB if Redis fails
        if (error.message.includes('Redis')) {
            return findLoadsFromDb(req, res);
        }
        res.status(500).json({ message: 'Internal server error while searching for loads.' });
    }
});

// DB only fallback for findLoads
async function findLoadsFromDb(req, res) {
    try {
        // This is a simplified version of the main handler without caching
        const { page, limit } = req.query;
        const offset = (page - 1) * limit;

        const countQuery = `SELECT COUNT(*) FROM loads WHERE (status IS NULL OR status = 'available')`;
        const { rows: countRows } = await pool.query(countQuery);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit);

        const queryStr = `SELECT * FROM loads WHERE (status IS NULL OR status = 'available') ORDER BY pickup_date ASC NULLS LAST LIMIT $1 OFFSET $2`;
        const queryParams = [limit, offset];
        const { rows: loads } = await pool.query(queryStr, queryParams);

        res.status(200).json({
            data: loads,
            pagination: { currentPage: page, totalPages, totalItems }
        });
    } catch (error) {
        console.error('Fallback DB Error:', error);
        res.status(500).json({ message: 'Internal server error during database fallback.' });
    }
}

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
    const { page = 1, limit = 12, sortBy = 'pickup_date', sortOrder = 'desc', search = '' } = req.query;
    const ownerId = req.user.id;
    const offset = (page - 1) * limit;

    try {
        let whereClause = 'WHERE owner_id = $1';
        const queryParams = [ownerId];
        let paramIndex = 2;

        if (search) {
            whereClause += ` AND title ILIKE $${paramIndex}`;
            queryParams.push(`%${search}%`);
            paramIndex++;
        }

        const countResult = await pool.query(`SELECT COUNT(*) FROM loads ${whereClause}`, queryParams);
        const totalItems = parseInt(countResult.rows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit) || 1;

        const queryStr = `
            SELECT id, title, description, pickup_address, delivery_address, 
                   pickup_date, delivery_date, status, eta, driver_id, required_vehicle_class, weight, rate
            FROM loads 
            ${whereClause}
            ORDER BY ${sortBy} ${sortOrder}
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        const { rows: loads } = await pool.query(queryStr, [...queryParams, limit, offset]);

        res.status(200).json({ data: loads, pagination: { currentPage: parseInt(page, 10), totalPages, totalItems } });
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
        const updateQuery = `
            UPDATE loads 
            SET status = 'en_route', driver_id = $1 
            WHERE id = $2 AND status = 'assigned'
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
    const driverId = req.user.id;

    try {
        // 1. Update the load status to 'assigned', but ONLY if it is currently available.
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
                await pool.query('UPDATE users SET penalty_count = COALESCE(penalty_count, 0) + 1 WHERE id = $1', [driverId]);
            }
        }

        // 3. Revert status to 'available', remove driver assignment
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
 * POST /api/loads/:id/bid
 * Allows a driver to place a bid on an available load.
 */
router.post('/:id/bid', protect, validate({ params: numericParamSchema('id'), body: bidSchema }), async (req, res) => {
    const loadId = req.params.id;
    const driverId = req.user.id;
    const { bidAmount, notes } = req.body;

    try {
        const loadQuery = await pool.query("SELECT owner_id, status FROM loads WHERE id = $1", [loadId]);
        const load = loadQuery.rows[0];

        if (!load) return res.status(404).json({ message: 'Load not found.' });
        if (load.owner_id === driverId) return res.status(400).json({ message: 'You cannot bid on your own load.' });
        if (load.status !== 'available' && load.status !== null) return res.status(400).json({ message: 'This load is no longer available for bidding.' });

        const bidQuery = await pool.query(
            'INSERT INTO bids (load_id, driver_id, bid_amount, notes) VALUES ($1, $2, $3, $4) RETURNING *',
            [loadId, driverId, bidAmount, notes]
        );

        res.status(201).json({ message: 'Bid placed successfully.', data: bidQuery.rows[0] });
    } catch (error) {
        console.error('Place Bid Error:', error);
        if (error.code === '23505') { // unique_violation
            return res.status(409).json({ message: 'You have already placed a bid on this load.' });
        }
        res.status(500).json({ message: 'Internal server error while placing bid.' });
    }
});

/**
 * GET /api/loads/:id/bids
 * Allows a shipper to view all bids on their load.
 */
router.get('/:id/bids', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const ownerId = req.user.id;

    try {
        const loadQuery = await pool.query("SELECT owner_id FROM loads WHERE id = $1", [loadId]);
        if (loadQuery.rows.length === 0) return res.status(404).json({ message: 'Load not found.' });
        if (loadQuery.rows[0].owner_id !== ownerId) return res.status(403).json({ message: 'Only the load owner can view bids.' });

        const bidsQuery = await pool.query(
            `SELECT b.*, u.name as driver_name, u.rating as driver_rating 
             FROM bids b JOIN users u ON b.driver_id = u.id 
             WHERE b.load_id = $1 ORDER BY b.created_at ASC`,
            [loadId]
        );

        res.status(200).json({ data: bidsQuery.rows });
    } catch (error) {
        console.error('Get Bids Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching bids.' });
    }
});

/**
 * POST /api/loads/:id/bids/:bidId/accept
 * Allows a shipper to accept a bid, assigning the load to the driver.
 */
router.post('/:id/bids/:bidId/accept', protect, validate({ params: numericParamSchema('id').extend({ bidId: z.string() }) }), async (req, res) => {
    const { id: loadId, bidId } = req.params;
    const ownerId = req.user.id;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const loadQuery = await client.query("SELECT status, title FROM loads WHERE id = $1 AND owner_id = $2 FOR UPDATE", [loadId, ownerId]);
        const load = loadQuery.rows[0];
        if (!load) throw { statusCode: 404, message: 'Load not found or you are not the owner.' };
        if (load.status !== 'available' && load.status !== null) throw { statusCode: 409, message: 'This load has already been assigned.' };

        const bidQuery = await client.query("SELECT driver_id, bid_amount FROM bids WHERE id = $1 AND load_id = $2", [bidId, loadId]);
        const bid = bidQuery.rows[0];
        if (!bid) throw { statusCode: 404, message: 'Bid not found.' };

        const activeLoadCheck = await client.query("SELECT id FROM loads WHERE driver_id = $1 AND status IN ('assigned', 'en_route')", [bid.driver_id]);
        if (activeLoadCheck.rows.length > 0) throw { statusCode: 409, message: 'The driver cannot be assigned because they have another active trip.' };

        await client.query("UPDATE loads SET status = 'assigned', driver_id = $1, accepted_at = NOW(), final_rate = $2 WHERE id = $3", [bid.driver_id, bid.bid_amount, loadId]);
        await client.query("UPDATE bids SET status = 'accepted' WHERE id = $1", [bidId]);
        await client.query("UPDATE bids SET status = 'rejected' WHERE load_id = $1 AND id != $2", [loadId, bidId]);

        const driverQuery = await client.query("SELECT email, name FROM users WHERE id = $1", [bid.driver_id]);
        const driver = driverQuery.rows[0];

        await client.query('COMMIT');

        if (driver) {
            await sendEmail({
                to: driver.email,
                subject: `Your Bid for "${load.title}" was Accepted!`,
                text: `Congratulations ${driver.name}, your bid for the load "${load.title}" has been accepted. Please log in to view details and start the trip.`
            });
        }

        res.status(200).json({ message: 'Bid accepted and load assigned successfully.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Accept Bid Error:', error);
        res.status(error.statusCode || 500).json({ message: error.message || 'Internal server error.' });
    } finally {
        client.release();
    }
});

/**
 * POST /api/loads/:id/rate
 * Allows a driver or shipper to rate the other party after completion.
 */
router.post('/:id/rate', protect, validate({ params: numericParamSchema('id'), body: rateSchema }), async (req, res) => {
    const loadId = req.params.id;
    const currentUserId = req.user.id;
    const { rating, targetUserId, review } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const loadQuery = await client.query('SELECT owner_id, driver_id, status FROM loads WHERE id = $1', [loadId]);
        const load = loadQuery.rows[0];

        if (!load) throw { statusCode: 404, message: 'Load not found.' };
        if (load.owner_id !== currentUserId && load.driver_id !== currentUserId) {
            throw { statusCode: 403, message: 'You are not authorized to rate this load.' };
        }
        if (load.owner_id !== targetUserId && load.driver_id !== targetUserId) {
            throw { statusCode: 400, message: 'Target user is not associated with this load.' };
        }
        if (load.status !== 'delivered') {
            throw { statusCode: 400, message: 'You can only rate a load after it has been delivered.' };
        }
        
        const existingRating = await client.query('SELECT id FROM load_ratings WHERE load_id = $1 AND rater_id = $2', [loadId, currentUserId]);
        if (existingRating.rows.length > 0) {
            throw { statusCode: 400, message: 'You have already submitted a rating for this load.' };
        }

        await client.query(
            'INSERT INTO load_ratings (load_id, rater_id, target_id, rating, review) VALUES ($1, $2, $3, $4, $5)',
            [loadId, currentUserId, targetUserId, rating, review]
        );

        const oldUserStats = await client.query('SELECT rating, rating_count, email, name FROM users WHERE id = $1 FOR UPDATE', [targetUserId]);
        const { rating: oldRating, rating_count: oldCount } = oldUserStats.rows[0];

        const newAvgRating = ((oldRating * oldCount) + rating) / (oldCount + 1);

        const { rows: updatedUser } = await client.query(
            `UPDATE users SET rating = $1, rating_count = rating_count + 1 WHERE id = $2 RETURNING rating`,
            [newAvgRating.toFixed(2), targetUserId]
        );

        await client.query('COMMIT');

        if (oldRating >= 3 && updatedUser[0].rating < 3) {
            await sendEmail({
                to: oldUserStats.rows[0].email,
                subject: 'Action Required: Your Average Rating Dropped',
                text: `Hi ${oldUserStats.rows[0].name},\n\nYour average rating has dropped below 3 stars. Please review your recent feedback to improve your service.`
            });
        }

        await redisClient.del(`user:${targetUserId}:reviews:page:1:limit:5`).catch(console.error);

        res.status(200).json({ message: 'Rating submitted successfully!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Submit Rating Error:', error);
        if (error.code === '23505') return res.status(400).json({ message: 'You have already submitted a rating for this load.' });
        res.status(error.statusCode || 500).json({ message: error.message || 'Internal server error while submitting rating.' });
    } finally {
        client.release();
    }
});

/**
 * PUT /api/loads/:id/rate
 * Allows a user to update their previously submitted rating.
 */
router.put('/:id/rate', protect, validate({ params: numericParamSchema('id'), body: updateRateSchema }), async (req, res) => {
    const loadId = req.params.id;
    const raterId = req.user.id;
    const { rating: newRating, review } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const ratingQuery = await client.query('SELECT target_id, rating FROM load_ratings WHERE load_id = $1 AND rater_id = $2 FOR UPDATE', [loadId, raterId]);
        const oldRatingData = ratingQuery.rows[0];
        if (!oldRatingData) throw { statusCode: 404, message: 'Rating not found.' };

        const { target_id: targetId, rating: oldRating } = oldRatingData;

        const userStats = await client.query('SELECT rating, rating_count FROM users WHERE id = $1 FOR UPDATE', [targetId]);
        const { rating: currentAvg, rating_count: count } = userStats.rows[0];

        const newAvg = ((currentAvg * count) - oldRating + newRating) / count;

        await client.query('UPDATE load_ratings SET rating = $1, review = $2, created_at = NOW() WHERE load_id = $3 AND rater_id = $4', [newRating, review, loadId, raterId]);
        await client.query('UPDATE users SET rating = $1 WHERE id = $2', [newAvg.toFixed(2), targetId]);

        await client.query('COMMIT');

        await redisClient.del(`user:${targetId}:reviews:page:1:limit:5`).catch(console.error);

        res.status(200).json({ message: 'Rating updated successfully!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Update Rating Error:', error);
        res.status(error.statusCode || 500).json({ message: error.message || 'Internal server error.' });
    } finally {
        client.release();
    }
});

/**
 * DELETE /api/loads/:id/rate
 * Allows a user to delete their previously submitted rating.
 */
router.delete('/:id/rate', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const raterId = req.user.id;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const deletedRatingQuery = await client.query('DELETE FROM load_ratings WHERE load_id = $1 AND rater_id = $2 RETURNING target_id, rating', [loadId, raterId]);
        const deletedRating = deletedRatingQuery.rows[0];
        if (!deletedRating) throw { statusCode: 404, message: 'Rating not found.' };

        const { target_id: targetId, rating } = deletedRating;

        const userStats = await client.query('SELECT rating, rating_count FROM users WHERE id = $1 FOR UPDATE', [targetId]);
        const { rating: currentAvg, rating_count: count } = userStats.rows[0];

        const newAvg = (count > 1) ? ((currentAvg * count) - rating) / (count - 1) : 0;
        const newCount = count - 1;

        await client.query(
            `UPDATE users SET rating = $1, rating_count = $2 WHERE id = $3`,
            [newAvg.toFixed(2), newCount, targetId]
        );

        await client.query('COMMIT');

        await redisClient.del(`user:${targetId}:reviews:page:1:limit:5`).catch(console.error);

        res.status(200).json({ message: 'Rating deleted successfully!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete Rating Error:', error);
        res.status(error.statusCode || 500).json({ message: error.message || 'Internal server error.' });
    } finally {
        client.release();
    }
});

/**
 * PUT /api/loads/:id
 * Updates an existing load.
 */
router.put('/:id', protect, upload.none(), validate({ params: numericParamSchema('id'), body: loadSchema }), async (req, res) => {
    const loadId = req.params.id;
    const ownerId = req.user.id;
    const { title, description, pickupAddress, deliveryAddress, pickupDate, deliveryDate, requiredVehicleClass, weight, rate } = req.body;

    try {
        const coordinates = await geocodeAddress(pickupAddress);
        const pickupLng = coordinates ? coordinates[0] : null;
        const pickupLat = coordinates ? coordinates[1] : null;

        const result = await pool.query(
            `UPDATE loads SET 
                title = $1, description = $2, pickup_address = $3, delivery_address = $4, 
                pickup_date = $5, delivery_date = $6, required_vehicle_class = $7, 
                weight = $8, rate = $9, pickup_lng = $10, pickup_lat = $11
             WHERE id = $12 AND owner_id = $13 AND (status IS NULL OR status = 'available')
             RETURNING *`,
            [title, description, pickupAddress, deliveryAddress, pickupDate, deliveryDate, requiredVehicleClass, weight, rate, pickupLng, pickupLat, loadId, ownerId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Load not found, you are not the owner, or it is already in progress.' });
        }

        res.status(200).json({ message: 'Load updated successfully.', data: result.rows[0] });
    } catch (error) {
        console.error('Update Load Error:', error);
        res.status(500).json({ message: 'Internal server error while updating load.' });
    }
});

/**
 * GET /api/loads/:id/bol
 * Securely streams a BOL document.
 */
router.get('/:id/bol', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const userId = req.user.id;

    try {
        const { rows } = await pool.query('SELECT owner_id, driver_id, bol_url, title FROM loads WHERE id = $1', [loadId]);
        const load = rows[0];

        if (!load) return res.status(404).json({ message: 'Load not found.' });
        if (load.owner_id !== userId && load.driver_id !== userId) return res.status(403).json({ message: 'You are not authorized to view this document.' });
        if (!load.bol_url) return res.status(404).json({ message: 'No Bill of Lading is attached to this load.' });

        const s3Key = getS3KeyFromUrl(load.bol_url);
        const { stream, contentType } = await getObjectStream(s3Key);

        const safeTitle = (load.title || 'load').replace(/[^a-z0-9]/gi, '_').toLowerCase();
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="BOL_${safeTitle}.pdf"`);
        stream.pipe(res);
    } catch (error) {
        console.error('BOL Stream Error:', error);
        res.status(500).json({ message: 'Error streaming document.' });
    }
});

/**
 * POST /api/loads/:id/signed-bol
 * Uploads a signed BOL document.
 */
router.post('/:id/signed-bol', protect, uploadSignedBol.single('signedBolDocument'), validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = parseInt(req.params.id, 10);
    const driverId = req.user.id;

    if (!req.file) return res.status(400).json({ message: 'No document uploaded. Please attach a signed BOL.' });

    try {
        const loadQuery = await pool.query("SELECT owner_id, title FROM loads WHERE id = $1 AND driver_id = $2", [loadId, driverId]);
        const load = loadQuery.rows[0];
        if (!load) return res.status(404).json({ message: 'Load not found or you are not the assigned driver.' });

        await pool.query('UPDATE loads SET signed_bol_url = $1 WHERE id = $2', [req.file.location, loadId]);

        const shipperQuery = await pool.query("SELECT email, name FROM users WHERE id = $1", [load.owner_id]);
        if (shipperQuery.rows.length > 0) {
            const shipper = shipperQuery.rows[0];
            await sendEmail({
                to: shipper.email,
                subject: `Signed BOL for Load "${load.title}"`,
                text: `The driver has uploaded the signed Bill of Lading for load "${load.title}". You can now view it in your load history.`
            });
        }

        res.status(200).json({ message: 'Signed BOL uploaded successfully!', data: { url: req.file.location } });
    } catch (error) {
        console.error('Signed BOL Upload Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

/**
 * GET /api/loads/:id/signed-bol
 * Securely streams a signed BOL document.
 */
router.get('/:id/signed-bol', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const userId = req.user.id;

    try {
        const { rows } = await pool.query('SELECT owner_id, driver_id, signed_bol_url, title FROM loads WHERE id = $1', [loadId]);
        const load = rows[0];

        if (!load) return res.status(404).json({ message: 'Load not found.' });
        if (load.owner_id !== userId && load.driver_id !== userId) return res.status(403).json({ message: 'You are not authorized to view this document.' });
        if (!load.signed_bol_url) return res.status(404).json({ message: 'No signed Bill of Lading is attached to this load.' });

        const s3Key = getS3KeyFromUrl(load.signed_bol_url);
        const { stream, contentType } = await getObjectStream(s3Key);

        const safeTitle = (load.title || 'load').replace(/[^a-z0-9]/gi, '_').toLowerCase();
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="SIGNED_BOL_${safeTitle}.pdf"`);
        stream.pipe(res);
    } catch (error) {
        console.error('Signed BOL Stream Error:', error);
        res.status(500).json({ message: 'Error streaming document.' });
    }
});

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