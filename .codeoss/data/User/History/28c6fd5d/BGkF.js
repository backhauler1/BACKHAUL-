const express = require('express');
const pool = require('./db');
const { protect, authorize } = require('./auth');
const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');
const { z } = require('zod');
const validate = require('./validate');
const { numericParamSchema } = require('./commonSchemas');
const sendEmail = require('./email');
const redisClient = require('./redis');
const { searchLimiter } = require('./rateLimiter');

const router = express.Router();

// Initialize multer for parsing multipart/form-data (required since the frontend sends FormData)
const upload = multer();

// Initialize S3 Client for BOL document uploads
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Configure Multer S3 Storage for Bills of Lading
const bolUpload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.AWS_S3_BUCKET_NAME,
        acl: 'private', // BOLs should generally be kept private
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            const uniqueSuffix = crypto.randomBytes(16).toString('hex');
            const ext = path.extname(file.originalname);
            cb(null, `loads/bols/bol-${uniqueSuffix}${ext}`);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const bidSchema = z.object({
    bidAmount: z.coerce.number().positive('Bid amount must be a positive number.'),
    notes: z.string().max(1000, 'Notes cannot exceed 1000 characters.').optional()
});

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
    weight: z.coerce.number().positive('Weight must be a positive number.').optional(),
    rate: z.coerce.number().positive('Rate must be a positive number.').optional(),
    biddingEndsAt: z.string().optional()
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
    targetUserId: z.coerce.number().int().positive('Invalid target user ID.'),
    review: z.string().max(1000, 'Review cannot exceed 1000 characters.').optional()
});

const updateRateSchema = z.object({
    rating: z.coerce.number().int().min(1, 'Rating must be at least 1 star.').max(5, 'Rating cannot exceed 5 stars.'),
    review: z.string().max(1000, 'Review cannot exceed 1000 characters.').optional()
});

/**
 * Helper to send an alert email if a user's rating drops below 3 stars.
 */
const checkAndSendRatingAlert = async (email, name, oldRating, newRating, oldRatingCount) => {
    const oldAvg = parseFloat(oldRating) || 0;
    const newAvg = parseFloat(newRating) || 0;
    const count = parseInt(oldRatingCount, 10) || 0;

    // Trigger if the rating drops below 3 from a >= 3 standing, or if it's their very first rating and it's < 3.
    // We check newAvg > 0 to ensure we don't alert them if they drop back to an unrated 0.0 status.
    if (newAvg > 0 && newAvg < 3 && (oldAvg >= 3 || count === 0)) {
        const emailOptions = {
            to: email,
            subject: 'Action Required: Your Average Rating Dropped',
            text: `Hi ${name},\n\nThis is an automated alert to let you know that your average rating has dropped to ${newAvg.toFixed(1)} stars.\n\nMaintaining a rating of 3 stars or above is important to continue receiving and booking loads.\n\nBest,\nYour App Team`,
            html: `
                <div style="font-family: sans-serif; line-height: 1.6;">
                    <h2>Rating Alert</h2>
                    <p>Hi ${name},</p>
                    <p>This is an automated alert to let you know that your average rating has dropped to <strong>${newAvg.toFixed(1)} stars</strong>.</p>
                    <p>Maintaining a rating of 3 stars or above is important to continue receiving and booking loads.</p>
                    <br>
                    <p>Best,</p>
                    <p><strong>Your App Team</strong></p>
                </div>
            `
        };
        try {
            await sendEmail(emailOptions);
        } catch (emailError) {
            console.error('Failed to send rating alert email:', emailError);
        }
    }
};

/**
 * POST /api/loads/post
 * Creates a new load listing. This route is protected and requires authentication.
 */
router.post('/post', protect, bolUpload.single('bolDocument'), validate({ body: loadSchema }), async (req, res) => {
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
        weight,
        rate,
        biddingEndsAt
    } = req.body;

    const ownerId = req.user.id; // From the `protect` middleware
    const bolUrl = req.file ? req.file.location : null; // Get the S3 URL if a file was uploaded

    // Shipper must be verified to post a load.
    if (!req.user.id_verified) {
        return res.status(403).json({ message: 'You must verify your identity before posting a load.' });
    }

    try {
        // 1. Check if the user owns any suspended companies
        const suspendedCompanyQuery = await pool.query(
            'SELECT id FROM companies WHERE owner_id = $1 AND is_suspended = true LIMIT 1',
            [ownerId]
        );

        if (suspendedCompanyQuery.rows.length > 0) {
            return res.status(403).json({ message: 'Cannot post load: Your company account is suspended.' });
        }

        // 2. Geocode the pickup address to get coordinates for the map
        // Check cache first to save Mapbox API requests
        const geocodeCacheKey = `geocode:${pickupAddress.toLowerCase().trim()}`;
        let pickupLng, pickupLat;
        
        try {
            const cachedCoords = await redisClient.get(geocodeCacheKey);
            if (cachedCoords) {
                [pickupLng, pickupLat] = JSON.parse(cachedCoords);
            }
        } catch (redisErr) {
            console.error('Redis GET Error during geocoding:', redisErr);
        }

        if (pickupLng === undefined || pickupLat === undefined) {
            const geoResponse = await geocodingService.forwardGeocode({
                query: pickupAddress,
                limit: 1,
            }).send();

            if (!geoResponse || !geoResponse.body || !geoResponse.body.features || geoResponse.body.features.length === 0) {
                return res.status(400).json({ message: 'Could not find coordinates for the specified pickup address.' });
            }

            [pickupLng, pickupLat] = geoResponse.body.features[0].center;
            
            // Cache the coordinates for 30 days
            try {
                await redisClient.setEx(geocodeCacheKey, 30 * 24 * 60 * 60, JSON.stringify([pickupLng, pickupLat]));
            } catch (redisErr) {
                console.error('Redis SET Error during geocoding:', redisErr);
            }
        }

        // 3. Insert the new load into the database
        // NOTE: This assumes your `loads` table has these columns.
        // The `pickup_location` column is ideal for PostGIS, but here we use separate lng/lat columns.
        const newLoadQuery = await pool.query(
            `INSERT INTO loads (owner_id, title, description, pickup_address, delivery_address, pickup_date, delivery_date, required_vehicle_class, weight, pickup_lng, pickup_lat, bol_url, rate, bidding_ends_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             RETURNING *`,
            [ownerId, title, description, pickupAddress, deliveryAddress, pickupDate, deliveryDate, requiredVehicleClass, weight, pickupLng, pickupLat, bolUrl, rate, biddingEndsAt]
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
router.post('/find', searchLimiter, upload.none(), validate({ body: findLoadsSchema, query: paginationQuerySchema }), async (req, res) => {
    const { startDate, endDate } = req.body;
    const backhaulOrigin = req.body['backhaul-origin'] || 'none';
    const backhaulDest = req.body['backhaul-destination'] || 'none';
    const { page, limit } = req.query;
    const offset = (page - 1) * limit;

    // Create a unique cache key based on the specific search parameters
    const cacheKey = `loads:find:page:${page}:limit:${limit}:start:${startDate || 'none'}:end:${endDate || 'none'}:origin:${backhaulOrigin}:dest:${backhaulDest}`;

    try {
        // 1. Try fetching from Redis first
        try {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
                return res.status(200).json(JSON.parse(cachedData));
            }
        } catch (redisErr) {
            console.error('Redis GET Error:', redisErr);
        }

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

        // Apply back-haul origin filter
        if (backhaulOrigin && backhaulOrigin !== 'none') {
            queryStr += ` AND pickup_address ILIKE $${paramIndex}`;
            queryParams.push(`%${backhaulOrigin}%`);
            paramIndex++;
        }

        // Apply back-haul destination filter
        if (backhaulDest && backhaulDest !== 'none') {
            queryStr += ` AND delivery_address ILIKE $${paramIndex}`;
            queryParams.push(`%${backhaulDest}%`);
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

        const responsePayload = {
            data: loads,
            pagination: { currentPage: page, totalPages, totalItems }
        };

        // 2. Save the result to Redis with a 60-second Time-To-Live (TTL)
        try {
            await redisClient.setEx(cacheKey, 60, JSON.stringify(responsePayload));
        } catch (redisErr) {
            console.error('Redis SET Error:', redisErr);
        }

        res.status(200).json(responsePayload);
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
                   pickup_date, delivery_date, status, accepted_at, eta,
                   (bol_url IS NOT NULL) as has_bol,
                   (signed_bol_url IS NOT NULL) as has_signed_bol
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
router.get('/posted', protect, validate({ query: paginationQuerySchema.extend({
    sortBy: z.enum(['pickup_date', 'title', 'status']).optional().default('pickup_date'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc')
}) }), async (req, res) => {
    const ownerId = req.user.id;
    const { page, limit, sortBy, sortOrder } = req.query;
    const offset = (page - 1) * limit;

    try {
        const countQuery = 'SELECT COUNT(*) FROM loads WHERE owner_id = $1';
        const { rows: countRows } = await pool.query(countQuery, [ownerId]);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit) || 1;

        const queryStr = `
            SELECT id, title, description, pickup_address, delivery_address, 
                   pickup_date, delivery_date, status, eta, driver_id,
                   (bol_url IS NOT NULL) as has_bol,
                   (signed_bol_url IS NOT NULL) as has_signed_bol
            FROM loads 
            WHERE owner_id = $1
            ORDER BY ${sortBy} ${sortOrder === 'asc' ? 'ASC' : 'DESC'} NULLS LAST
            LIMIT $2 OFFSET $3
        `;
        
        const { rows: loads } = await pool.query(queryStr, [ownerId, limit, offset]);

        res.status(200).json({ 
            data: loads,
            pagination: { currentPage: page, totalPages, totalItems }
        });
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

    // Driver must be verified to accept an available load directly.
    if (!req.user.id_verified) {
        return res.status(403).json({ message: 'You must verify your identity before accepting a load.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Check if the driver is already on an active load to prevent double-booking
        const activeLoadCheck = await client.query(
            "SELECT id FROM loads WHERE driver_id = $1 AND status IN ('assigned', 'en_route', 'arrived', 'loading_completed')",
            [driverId]
        );

        if (activeLoadCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'You cannot accept a new load while you have another active trip.' });
        }

        // 2. Update the load status to 'assigned', but ONLY if it is currently available.
        const updateQuery = `
            UPDATE loads 
            SET status = 'assigned', driver_id = $1, accepted_at = NOW()
            WHERE id = $2 AND (status IS NULL OR status = 'available')
            RETURNING title, owner_id, accepted_at
        `;
        const { rows } = await client.query(updateQuery, [driverId, loadId]);

        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Load is no longer available or has already been accepted.' });
        }

        const updatedLoad = rows[0];

        // 3. Fetch shipper and driver info for notifications
        const userQuery = await client.query('SELECT email, name FROM users WHERE id = $1', [updatedLoad.owner_id]);
        const shipper = userQuery.rows[0];
        const driverQuery = await client.query('SELECT email, name FROM users WHERE id = $1', [driverId]);
        const driver = driverQuery.rows[0];

        await client.query('COMMIT');

        // 4. Send emails after the transaction is successfully committed
        if (shipper) {
            const emailOptions = {
                to: shipper.email,
                subject: `Load Accepted: "${updatedLoad.title}"`,
                text: `Hi ${shipper.name},\n\nGreat news! A driver has officially accepted your load "${updatedLoad.title}".\n\nNote: The driver has a 15-minute grace period to back out without penalty. We will notify you immediately if they cancel.\n\nBest,\nYour App Team`,
                html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Load Accepted!</h2><p>Hi ${shipper.name},</p><p>Great news! A driver has officially accepted your load <strong>"${updatedLoad.title}"</strong>.</p><p><em>Note: The driver has a 15-minute grace period to back out without penalty. We will notify you immediately if they cancel.</em></p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
            };
            sendEmail(emailOptions).catch(err => console.error("Failed to send shipper notification:", err));
        }

        if (driver) {
            const emailOptions = {
                to: driver.email,
                subject: `You Accepted Load: "${updatedLoad.title}"`,
                text: `Hi ${driver.name},\n\nYou have successfully accepted the load "${updatedLoad.title}".\n\nYou have a 15-minute grace period to cancel this acceptance without penalty. If you cancel after 15 minutes, a penalty will be applied to your account.\n\nBest,\nYour App Team`,
                html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Load Accepted</h2><p>Hi ${driver.name},</p><p>You have successfully accepted the load <strong>"${updatedLoad.title}"</strong>.</p><p><strong>Important:</strong> You have a 15-minute grace period to cancel this acceptance without penalty. If you cancel after 15 minutes, a penalty will be applied to your account.</p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
            };
            sendEmail(emailOptions).catch(err => console.error("Failed to send driver notification:", err));
        }

        res.status(200).json({ message: 'Load accepted successfully!', data: { accepted_at: updatedLoad.accepted_at } });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Accept Load Error:', error);
        res.status(500).json({ message: 'Internal server error while accepting load.' });
    } finally {
        client.release();
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
    const { rating, targetUserId, review } = req.body;

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
        
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 3. Prevent duplicate ratings by checking the ledger
            const existingRatingQuery = await client.query(
                'SELECT 1 FROM load_ratings WHERE load_id = $1 AND rater_id = $2', 
                [loadId, currentUserId]
            );
            
            if (existingRatingQuery.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'You have already submitted a rating for this load.' });
            }

            // 4. Record the rating in the ledger
            await client.query(
                'INSERT INTO load_ratings (load_id, rater_id, target_id, rating, review) VALUES ($1, $2, $3, $4, $5)',
                [loadId, currentUserId, targetUserId, rating, review]
            );
            
            const userCheck = await client.query('SELECT rating, rating_count, email, name FROM users WHERE id = $1', [targetUserId]);
            const oldUserStats = userCheck.rows[0];

            // 5. Calculate and update the target user's new average rating
            const updateQuery = `
                UPDATE users 
                SET rating = ((rating * rating_count) + $1::numeric) / (rating_count + 1),
                    rating_count = rating_count + 1
                WHERE id = $2
                RETURNING rating
            `;
            const { rows: updatedUsers } = await client.query(updateQuery, [rating, targetUserId]);

            await client.query('COMMIT');

            try {
                await redisClient.del(`user:${targetUserId}:reviews:page:1:limit:5`);
            } catch (redisErr) {
                console.error('Redis cache invalidation error:', redisErr);
            }

            if (oldUserStats) {
                checkAndSendRatingAlert(oldUserStats.email, oldUserStats.name, oldUserStats.rating, updatedUsers[0]?.rating, oldUserStats.rating_count);
            }

            res.status(200).json({ message: 'Rating submitted successfully!' });
        } catch (dbError) {
            await client.query('ROLLBACK');
            throw dbError;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Submit Rating Error:', error);
        res.status(500).json({ message: 'Internal server error while submitting rating.' });
    }
});

/**
 * PUT /api/loads/:id/rate
 * Allows a user to edit their previously submitted rating.
 */
router.put('/:id/rate', protect, validate({ params: numericParamSchema('id'), body: updateRateSchema }), async (req, res) => {
    const loadId = req.params.id;
    const currentUserId = req.user.id;
    const { rating: newRating, review: newReview } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const ratingQuery = await client.query('SELECT target_id, rating FROM load_ratings WHERE load_id = $1 AND rater_id = $2', [loadId, currentUserId]);
        if (ratingQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Rating not found.' });
        }
        
        const { target_id, rating: oldRating } = ratingQuery.rows[0];

        const userCheck = await client.query('SELECT rating, rating_count, email, name FROM users WHERE id = $1', [target_id]);
        const oldUserStats = userCheck.rows[0];

        await client.query('UPDATE load_ratings SET rating = $1, review = $2 WHERE load_id = $3 AND rater_id = $4', [newRating, newReview, loadId, currentUserId]);

        const updateQuery = `
            UPDATE users 
            SET rating = ((rating * rating_count) - $1::numeric + $2::numeric) / rating_count
            WHERE id = $3 AND rating_count > 0
            RETURNING rating
        `;
        const { rows: updatedUsers } = await client.query(updateQuery, [oldRating, newRating, target_id]);

        await client.query('COMMIT');

        try {
            await redisClient.del(`user:${target_id}:reviews:page:1:limit:5`);
        } catch (redisErr) {
            console.error('Redis cache invalidation error:', redisErr);
        }

        if (oldUserStats) {
            checkAndSendRatingAlert(oldUserStats.email, oldUserStats.name, oldUserStats.rating, updatedUsers[0]?.rating, oldUserStats.rating_count);
        }

        res.status(200).json({ message: 'Rating updated successfully!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Update Rating Error:', error);
        res.status(500).json({ message: 'Internal server error while updating rating.' });
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
    const currentUserId = req.user.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const ratingQuery = await client.query('SELECT target_id, rating FROM load_ratings WHERE load_id = $1 AND rater_id = $2', [loadId, currentUserId]);
        if (ratingQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Rating not found.' });
        }
        
        const { target_id, rating: oldRating } = ratingQuery.rows[0];

        const userCheck = await client.query('SELECT rating, rating_count, email, name FROM users WHERE id = $1', [target_id]);
        const oldUserStats = userCheck.rows[0];

        await client.query('DELETE FROM load_ratings WHERE load_id = $1 AND rater_id = $2', [loadId, currentUserId]);

        const updateQuery = `
            UPDATE users 
            SET rating = CASE WHEN rating_count > 1 THEN ((rating * rating_count) - $1::numeric) / (rating_count - 1) ELSE 0 END,
                rating_count = GREATEST(rating_count - 1, 0)
            WHERE id = $2
            RETURNING rating
        `;
        const { rows: updatedUsers } = await client.query(updateQuery, [oldRating, target_id]);

        await client.query('COMMIT');

        try {
            await redisClient.del(`user:${target_id}:reviews:page:1:limit:5`);
        } catch (redisErr) {
            console.error('Redis cache invalidation error:', redisErr);
        }

        if (oldUserStats) {
            checkAndSendRatingAlert(oldUserStats.email, oldUserStats.name, oldUserStats.rating, updatedUsers[0]?.rating, oldUserStats.rating_count);
        }

        res.status(200).json({ message: 'Rating deleted successfully!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete Rating Error:', error);
        res.status(500).json({ message: 'Internal server error while deleting rating.' });
    } finally {
        client.release();
    }
});

/**
 * GET /api/loads/:id/bol
 * Securely streams the Bill of Lading document for a load to the assigned driver or shipper.
 */
router.get('/:id/bol', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const currentUserId = req.user.id;

    try {
        // 1. Fetch the load to verify permissions and get the S3 URL
        const loadQuery = await pool.query('SELECT owner_id, driver_id, bol_url, title FROM loads WHERE id = $1', [loadId]);
        const load = loadQuery.rows[0];

        if (!load) {
            return res.status(404).json({ message: 'Load not found.' });
        }

        // 2. Ensure only the shipper or the assigned driver can access the private document
        if (load.owner_id !== currentUserId && load.driver_id !== currentUserId) {
            return res.status(403).json({ message: 'You are not authorized to view this document.' });
        }

        if (!load.bol_url) {
            return res.status(404).json({ message: 'No Bill of Lading document is attached to this load.' });
        }

        // 3. Extract the exact S3 object key from the saved URL
        const urlObj = new URL(load.bol_url);
        const s3Key = decodeURIComponent(urlObj.pathname.substring(1)); // Remove the leading slash

        // 4. Fetch the file stream from S3 securely using the backend's IAM credentials
        const command = new GetObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: s3Key,
        });
        const s3Response = await s3.send(command);

        // 5. Set appropriate headers and stream the file directly to the client's browser
        const ext = path.extname(s3Key) || '.pdf';
        const safeTitle = load.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        
        res.setHeader('Content-Type', s3Response.ContentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="BOL_${safeTitle}${ext}"`);

        // Stream the S3 readable stream to the Express response object
        s3Response.Body.pipe(res);
    } catch (error) {
        console.error('Download BOL Error:', error);
        res.status(500).json({ message: 'Internal server error while retrieving the document.' });
    }
});

/**
 * POST /api/loads/:id/signed-bol
 * Allows the assigned driver to upload a signed copy of the Bill of Lading.
 */
router.post('/:id/signed-bol', protect, bolUpload.single('signedBolDocument'), validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const driverId = req.user.id;
    const signedBolUrl = req.file ? req.file.location : null;

    if (!signedBolUrl) {
        return res.status(400).json({ message: 'No document uploaded. Please attach a signed BOL.' });
    }

    try {
        // 1. Verify the load exists and the current user is the assigned driver
        const loadQuery = await pool.query('SELECT owner_id, title FROM loads WHERE id = $1 AND driver_id = $2', [loadId, driverId]);
        const load = loadQuery.rows[0];

        if (!load) {
            return res.status(404).json({ message: 'Load not found or you are not authorized to upload documents for it.' });
        }

        // 2. Update the database with the signed BOL URL
        await pool.query(
            'UPDATE loads SET signed_bol_url = $1 WHERE id = $2',
            [signedBolUrl, loadId]
        );

        // 3. Notify the shipper that the signed BOL is ready
        const userQuery = await pool.query('SELECT email, name FROM users WHERE id = $1', [load.owner_id]);
        const shipper = userQuery.rows[0];

        if (shipper) {
            const emailOptions = {
                to: shipper.email,
                subject: `Signed BOL Uploaded: "${load.title}"`,
                text: `Hi ${shipper.name},\n\nThe driver for your load "${load.title}" has successfully uploaded the signed Bill of Lading.\n\nBest,\nYour App Team`,
                html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Signed BOL Uploaded</h2><p>Hi ${shipper.name},</p><p>The driver for your load <strong>"${load.title}"</strong> has successfully uploaded the signed Bill of Lading.</p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
            };
            await sendEmail(emailOptions);
        }

        res.status(200).json({ message: 'Signed BOL uploaded successfully!' });
    } catch (error) {
        console.error('Upload Signed BOL Error:', error);
        res.status(500).json({ message: 'Internal server error while uploading the document.' });
    }
});

/**
 * GET /api/loads/:id/signed-bol
 * Securely streams the signed Bill of Lading document to the assigned driver or shipper.
 */
router.get('/:id/signed-bol', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const currentUserId = req.user.id;

    try {
        const loadQuery = await pool.query('SELECT owner_id, driver_id, signed_bol_url, title FROM loads WHERE id = $1', [loadId]);
        const load = loadQuery.rows[0];

        if (!load) {
            return res.status(404).json({ message: 'Load not found.' });
        }

        if (load.owner_id !== currentUserId && load.driver_id !== currentUserId) {
            return res.status(403).json({ message: 'You are not authorized to view this document.' });
        }

        if (!load.signed_bol_url) {
            return res.status(404).json({ message: 'No signed Bill of Lading has been uploaded for this load yet.' });
        }

        const urlObj = new URL(load.signed_bol_url);
        const s3Key = decodeURIComponent(urlObj.pathname.substring(1));

        const command = new GetObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: s3Key,
        });
        const s3Response = await s3.send(command);

        const ext = path.extname(s3Key) || '.pdf';
        const safeTitle = load.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        
        res.setHeader('Content-Type', s3Response.ContentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="Signed_BOL_${safeTitle}${ext}"`);

        s3Response.Body.pipe(res);
    } catch (error) {
        console.error('Download Signed BOL Error:', error);
        res.status(500).json({ message: 'Internal server error while retrieving the signed document.' });
    }
});

/**
 * POST /api/loads/:id/bid
 * Places a bid on a load.
 */
router.post('/:id/bid', protect, validate({ params: numericParamSchema('id'), body: bidSchema }), async (req, res) => {
    const loadId = req.params.id;
    const driverId = req.user.id;
    const { bidAmount, notes } = req.body;

    // Driver must be verified to place a bid.
    if (!req.user.id_verified) {
        return res.status(403).json({ message: 'You must verify your identity before placing a bid.' });
    }

    try {
        const loadQuery = await pool.query("SELECT status, owner_id FROM loads WHERE id = $1", [loadId]);
        const load = loadQuery.rows[0];
        
        if (!load) return res.status(404).json({ message: 'Load not found.' });
        if (load.status && load.status !== 'available') return res.status(400).json({ message: 'Load is not available for bidding.' });
        if (load.owner_id === driverId) return res.status(400).json({ message: 'You cannot bid on your own load.' });

        const newBidQuery = await pool.query(
            `INSERT INTO bids (load_id, driver_id, bid_amount, notes)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [loadId, driverId, bidAmount, notes]
        );

        res.status(201).json({ message: 'Bid placed successfully.', data: newBidQuery.rows[0] });
    } catch (error) {
        console.error('Place Bid Error:', error);
        res.status(500).json({ message: 'Internal server error while placing bid.' });
    }
});

/**
 * GET /api/loads/:id/bids
 * Retrieves all bids for a specific load.
 */
router.get('/:id/bids', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const loadId = req.params.id;
    const userId = req.user.id;

    try {
        const loadQuery = await pool.query("SELECT owner_id FROM loads WHERE id = $1", [loadId]);
        const load = loadQuery.rows[0];
        
        if (!load) return res.status(404).json({ message: 'Load not found.' });
        if (load.owner_id !== userId) return res.status(403).json({ message: 'Only the load owner can view bids.' });

        const bidsQuery = await pool.query(
            `SELECT b.id, b.bid_amount, b.notes, b.status, b.created_at, u.name as driver_name, u.rating as driver_rating
             FROM bids b
             JOIN users u ON b.driver_id = u.id
             WHERE b.load_id = $1
             ORDER BY b.bid_amount ASC`,
            [loadId]
        );

        res.status(200).json({ data: bidsQuery.rows });
    } catch (error) {
        console.error('Fetch Bids Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching bids.' });
    }
});

/**
 * POST /api/loads/:id/bids/:bidId/accept
 * Accepts a bid and assigns the load.
 */
router.post('/:id/bids/:bidId/accept', protect, validate({ params: z.object({ id: z.coerce.number().int().positive(), bidId: z.coerce.number().int().positive() }) }), async (req, res) => {
    const loadId = req.params.id;
    const bidId = req.params.bidId;
    const ownerId = req.user.id;

    // Shipper (load owner) must be verified to accept a bid.
    if (!req.user.id_verified) {
        return res.status(403).json({ message: 'You must verify your identity before accepting a bid.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const loadQuery = await client.query("SELECT status, title FROM loads WHERE id = $1 AND owner_id = $2", [loadId, ownerId]);
        const load = loadQuery.rows[0];

        if (!load) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Load not found or unauthorized.' });
        }
        if (load.status && load.status !== 'available') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Load is no longer available.' });
        }

        // Fetch bid and check if the bidding driver is verified.
        const bidQuery = await client.query(
            `SELECT b.driver_id, b.bid_amount, u.id_verified as driver_is_verified
             FROM bids b
             JOIN users u ON b.driver_id = u.id
             WHERE b.id = $1 AND b.load_id = $2`,
            [bidId, loadId]
        );
        const bid = bidQuery.rows[0];

        if (!bid) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Bid not found.' });
        }

        // The driver whose bid is being accepted must also be verified.
        if (!bid.driver_is_verified) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'Cannot accept bid: The selected driver has not verified their identity.' });
        }

        const activeLoadCheck = await client.query(
            "SELECT id FROM loads WHERE driver_id = $1 AND status IN ('assigned', 'en_route', 'arrived', 'loading_completed')",
            [bid.driver_id]
        );

        if (activeLoadCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'The driver cannot be assigned because they have another active trip.' });
        }

        await client.query(
            "UPDATE loads SET status = 'assigned', driver_id = $1, rate = $2, accepted_at = NOW() WHERE id = $3",
            [bid.driver_id, bid.bid_amount, loadId]
        );

        await client.query("UPDATE bids SET status = 'accepted' WHERE id = $1", [bidId]);
        await client.query("UPDATE bids SET status = 'rejected' WHERE load_id = $1 AND id != $2", [loadId, bidId]);

        const driverQuery = await client.query('SELECT email, name FROM users WHERE id = $1', [bid.driver_id]);
        const driver = driverQuery.rows[0];

        await client.query('COMMIT');

        if (driver) {
             const emailOptions = {
                to: driver.email,
                subject: `Bid Accepted: "${load.title}"`,
                text: `Hi ${driver.name},\n\nYour bid of $${bid.bid_amount} for "${load.title}" has been accepted. You are now assigned to this load.\n\nBest,\nYour App Team`,
                html: `<div style="font-family: sans-serif; line-height: 1.6;"><h2>Bid Accepted!</h2><p>Hi ${driver.name},</p><p>Your bid of <strong>$${bid.bid_amount}</strong> for <strong>"${load.title}"</strong> has been accepted. You are now assigned to this load.</p><br><p>Best,</p><p><strong>Your App Team</strong></p></div>`
             };
             sendEmail(emailOptions).catch(err => console.error("Failed to send bid acceptance email:", err));
        }

        res.status(200).json({ message: 'Bid accepted and load assigned successfully.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Accept Bid Error:', error);
        res.status(500).json({ message: 'Internal server error while accepting bid.' });
    } finally {
        client.release();
    }
});

module.exports = router;