const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const router = express.Router();
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const multerS3 = require('multer-s3');
const validate = require('../validate');
const { numericParamSchema } = require('../commonSchemas');
const { z } = require('zod');
const { protect, authorize } = require('../middleware/auth');
const pool = require('../db');
const { uploadLimiter, searchLimiter } = require('../rateLimiter');
const redisClient = require('../redis');

// S3 Client
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Mapbox Geocoding client
const geocodingService = mbxGeocoding({ accessToken: process.env.MAPBOX_TOKEN });

// Multer instance to parse multipart forms without file uploads
const noFileUpload = multer();

// Multer S3 storage for truck thumbnails
const storage = multerS3({
    s3: s3,
    bucket: process.env.AWS_S3_BUCKET_NAME,
    acl: 'public-read',
    metadata: function (req, file, cb) {
        cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
        const uniqueSuffix = crypto.randomBytes(16).toString('hex');
        const ext = path.extname(file.originalname);
        cb(null, `trucks/thumbnails/truck-${uniqueSuffix}${ext}`);
    }
});

// File filter for images
const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('INVALID_FILE_TYPE'), false);
    }
};

// Multer instance for truck thumbnails
const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5 MB limit
    }
});

// Zod schema for truck text fields
const truckSchema = z.object({
    truckName: z.string().min(1, 'Truck name is required.'),
    truckType: z.enum(['flatbed', 'dry_van', 'reefer', 'other']),
    capacity: z.coerce.number().positive().optional(),
    homeBase: z.string().min(1, 'Home base location is required.'),
});

// Zod schema for pagination and search
const listQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(50).default(15),
    search: z.string().optional(),
});

// POST /api/trucks/register - Register a new truck
router.post('/register', protect, authorize('driver'), uploadLimiter, upload.single('thumbnail'), validate({ body: truckSchema }), async (req, res) => {
    try {
        const { truckName, truckType, capacity, homeBase } = req.body;
        const ownerId = req.user.id;

        let thumbnailUrl = req.file ? req.file.location : null;

        // Geocode homeBase location
        let lng = null;
        let lat = null;
        if (homeBase) {
            const geocodeCacheKey = `geocode:${homeBase.toLowerCase().trim()}`;
            try {
                const cachedCoords = await redisClient.get(geocodeCacheKey);
                if (cachedCoords) {
                    [lng, lat] = JSON.parse(cachedCoords);
                } else {
                    const geoResponse = await geocodingService.forwardGeocode({ query: homeBase, limit: 1 }).send();
                    if (geoResponse && geoResponse.body.features.length > 0) {
                        [lng, lat] = geoResponse.body.features[0].center;
                        await redisClient.setEx(geocodeCacheKey, 30 * 24 * 60 * 60, JSON.stringify([lng, lat]));
                    }
                }
            } catch (err) {
                console.error('Geocoding/Redis error during truck registration:', err.message);
            }
        }

        const newTruckQuery = await pool.query(
            `INSERT INTO trucks (name, type, capacity, home_base, thumbnail_url, owner_id, lng, lat) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
             RETURNING *`,
            [truckName, truckType, capacity, homeBase, thumbnailUrl, ownerId, lng, lat]
        );

        res.status(201).json({ 
            message: 'Truck registered successfully!',
            data: newTruckQuery.rows[0]
        });

    } catch (error) {
        console.error('Truck Registration Error:', error);
        res.status(500).json({ message: 'Internal server error during truck registration.' });
    }
});

// GET /api/trucks/me - Get current user's registered trucks
router.get('/me', protect, authorize('driver'), async (req, res) => {
    const ownerId = req.user.id;

    try {
        const queryStr = `
            SELECT id, name, type, capacity, thumbnail_url, home_base, is_available, created_at 
            FROM trucks 
            WHERE owner_id = $1 
            ORDER BY created_at DESC
        `;
        const { rows: trucks } = await pool.query(queryStr, [ownerId]);
        res.status(200).json({ data: trucks });
    } catch (error) {
        console.error('Fetch My Trucks Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching your trucks.' });
    }
});

// PUT /api/trucks/:id - Update a truck
router.put('/:id', protect, authorize('driver', 'admin'), validate({ params: numericParamSchema('id') }), upload.single('thumbnail'), validate({ body: truckSchema.partial() }), async (req, res) => {
    const truckId = req.params.id;
    const userId = req.user.id;

    try {
        const truckQuery = await pool.query('SELECT thumbnail_url, owner_id FROM trucks WHERE id = $1', [truckId]);
        const truck = truckQuery.rows[0];

        if (!truck) {
            return res.status(404).json({ message: 'Truck not found.' });
        }

        if (truck.owner_id !== userId && !req.user.roles.includes('admin')) {
            return res.status(403).json({ message: 'Not authorized to update this truck.' });
        }

        let newThumbnailUrl = truck.thumbnail_url;
        if (req.file) {
            newThumbnailUrl = req.file.location;
            if (truck.thumbnail_url) {
                try {
                    const urlObj = new URL(truck.thumbnail_url);
                    const oldKey = decodeURIComponent(urlObj.pathname.substring(1));
                    await s3.send(new DeleteObjectCommand({
                        Bucket: process.env.AWS_S3_BUCKET_NAME,
                        Key: oldKey,
                    }));
                } catch (s3Error) {
                    console.error('Failed to delete old truck thumbnail from S3:', s3Error);
                }
            }
        }

        const { truckName, truckType, capacity, homeBase } = req.body;

        const updateQuery = await pool.query(
            `UPDATE trucks 
             SET name = COALESCE($1, name), type = COALESCE($2, type), 
                 capacity = COALESCE($3, capacity), home_base = COALESCE($4, home_base), 
                 thumbnail_url = $5
             WHERE id = $6 RETURNING *`,
            [truckName, truckType, capacity, homeBase, newThumbnailUrl, truckId]
        );

        res.status(200).json({ message: 'Truck profile updated successfully.', data: updateQuery.rows[0] });
    } catch (error) {
        console.error('Update Truck Error:', error);
        res.status(500).json({ message: 'Internal server error during update.' });
    }
});

// DELETE /api/trucks/:id - Delete a truck
router.delete('/:id', protect, authorize('driver', 'admin'), validate({ params: numericParamSchema('id') }), async (req, res) => {
    const truckId = req.params.id;
    const userId = req.user.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const truckQuery = await client.query('SELECT thumbnail_url, owner_id FROM trucks WHERE id = $1', [truckId]);
        const truck = truckQuery.rows[0];

        if (!truck) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Truck not found.' });
        }

        if (truck.owner_id !== userId && !req.user.roles.includes('admin')) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'Not authorized to delete this truck.' });
        }

        if (truck.thumbnail_url) {
            try {
                const urlObj = new URL(truck.thumbnail_url);
                const key = decodeURIComponent(urlObj.pathname.substring(1));
                await s3.send(new DeleteObjectCommand({
                    Bucket: process.env.AWS_S3_BUCKET_NAME,
                    Key: key,
                }));
            } catch (s3Error) {
                console.error(`Failed to delete thumbnail from S3 for truck ${truckId}:`, s3Error);
            }
        }

        await client.query('DELETE FROM trucks WHERE id = $1', [truckId]);

        await client.query('COMMIT');
        res.status(200).json({ message: `Truck ID ${truckId} deleted successfully.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete Truck Error:', error);
        if (error.code === '23503') {
            return res.status(409).json({ message: 'Cannot delete truck. It has associated records (e.g., active loads) that must be handled first.' });
        }
        res.status(500).json({ message: 'Internal server error during deletion.' });
    } finally {
        client.release();
    }
});

// GET /api/trucks - Admin route to list all trucks
router.get('/', protect, authorize('admin'), validate({ query: listQuerySchema }), async (req, res) => {
    const { page, limit, search } = req.query;
    const offset = (page - 1) * limit;

    try {
        const params = [];
        let paramIndex = 1;
        let whereClause = '';

        if (search) {
            whereClause = ` WHERE t.name ILIKE $${paramIndex} OR u.name ILIKE $${paramIndex}`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        const countQuery = `SELECT COUNT(t.id) FROM trucks t LEFT JOIN users u ON t.owner_id = u.id${whereClause}`;
        const { rows: countRows } = await pool.query(countQuery, search ? [`%${search}%`] : []);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit) || 1;

        const queryStr = `
            SELECT t.id, t.name, t.type, t.is_available, t.created_at, u.id as owner_id, u.name as owner_name
            FROM trucks t
            LEFT JOIN users u ON t.owner_id = u.id
            ${whereClause}
            ORDER BY t.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `;
        params.push(limit, offset);

        const { rows: trucks } = await pool.query(queryStr, params);

        res.status(200).json({
            data: trucks,
            pagination: { currentPage: page, totalPages, totalItems }
        });
    } catch (error) {
        console.error('Fetch Trucks Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching trucks.' });
    }
});

// PATCH /api/trucks/:id/availability - Toggle truck availability
const availabilitySchema = z.object({
    isAvailable: z.boolean()
});

router.patch('/:id/availability', protect, authorize('driver'), validate({ params: numericParamSchema('id'), body: availabilitySchema }), async (req, res) => {
    const truckId = req.params.id;
    const userId = req.user.id;
    const { isAvailable } = req.body;

    try {
        const updateQuery = await pool.query(
            'UPDATE trucks SET is_available = $1 WHERE id = $2 AND owner_id = $3 RETURNING id, name, is_available',
            [isAvailable, truckId, userId]
        );

        if (updateQuery.rows.length === 0) {
            return res.status(404).json({ message: 'Truck not found or you are not the owner.' });
        }

        const action = isAvailable ? 'available' : 'unavailable';
        res.status(200).json({ message: `Truck status updated to ${action}.`, data: updateQuery.rows[0] });
    } catch (error) {
        console.error('Update Truck Availability Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// POST /api/trucks/find - Public search for available trucks
const findTruckSchema = z.object({
    origin: z.string().optional(),
    radius: z.coerce.number().positive().optional(),
    truckType: z.string().optional(),
}).passthrough();

const findTruckQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(50).default(15),
});

router.post('/find', searchLimiter, noFileUpload.none(), validate({ body: findTruckSchema, query: findTruckQuerySchema }), async (req, res) => {
    const { origin, radius = 50, truckType } = req.body;
    const { page, limit } = req.query;
    const offset = (page - 1) * limit;

    try {
        const queryParams = [];
        let paramIndex = 1;
        let whereClauses = ['is_available = true'];

        if (truckType) {
            whereClauses.push(`type = $${paramIndex++}`);
            queryParams.push(truckType);
        }

        let distanceSelection = '';
        let orderBy = 'ORDER BY created_at DESC';

        if (origin) {
            let originLng, originLat;
            const geocodeCacheKey = `geocode:${origin.toLowerCase().trim()}`;
            try {
                const cachedCoords = await redisClient.get(geocodeCacheKey);
                if (cachedCoords) {
                    [originLng, originLat] = JSON.parse(cachedCoords);
                } else {
                    const geoResponse = await geocodingService.forwardGeocode({ query: origin, limit: 1 }).send();
                    if (geoResponse && geoResponse.body.features.length > 0) {
                        [originLng, originLat] = geoResponse.body.features[0].center;
                        await redisClient.setEx(geocodeCacheKey, 30 * 24 * 60 * 60, JSON.stringify([originLng, originLat]));
                    }
                }
            } catch (err) {
                console.error('Geocoding/Redis error during truck find:', err.message);
            }

            if (originLng && originLat) {
                const radiusInMeters = radius * 1609.34;
                whereClauses.push(`ST_DWithin(ST_MakePoint(lng, lat)::geography, ST_MakePoint($${paramIndex++}, $${paramIndex++})::geography, $${paramIndex++})`);
                queryParams.push(originLng, originLat, radiusInMeters);

                distanceSelection = `, ST_Distance(ST_MakePoint(lng, lat)::geography, ST_MakePoint($${paramIndex++}, $${paramIndex++})::geography) / 1609.34 AS distance`;
                queryParams.push(originLng, originLat);
                orderBy = 'ORDER BY distance ASC';
            }
        }

        const whereString = `WHERE ${whereClauses.join(' AND ')}`;

        const countParams = queryParams.slice(0, whereClauses.length);
        const countQuery = `SELECT COUNT(id) FROM trucks ${whereString}`;
        const { rows: countRows } = await pool.query(countQuery, countParams);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit) || 1;

        let queryStr = `
            SELECT id, name, type, capacity, thumbnail_url, home_base, is_available, lng, lat ${distanceSelection}
            FROM trucks
            ${whereString}
            ${orderBy}
            LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `;
        queryParams.push(limit, offset);

        const { rows: trucks } = await pool.query(queryStr, queryParams);

        res.status(200).json({
            data: trucks,
            pagination: { currentPage: page, totalPages, totalItems }
        });

    } catch (error) {
        console.error('Find Trucks Error:', error);
        if (error.code === '42883') { // PostGIS function does not exist
            return res.status(500).json({ message: 'Location-based search is currently unavailable. PostGIS extension may not be enabled.' });
        }
        res.status(500).json({ message: 'Internal server error while searching for trucks.' });
    }
});

// Multer error handler
router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'File is too large.' });
    } else if (error.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ message: 'Invalid file format. Please upload a JPEG, PNG, GIF, or WebP.' });
    }
    next(error);
});

module.exports = router;