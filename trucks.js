const express = require('express');
const router = express.Router();
const pool = require('./db');
const { protect } = require('./auth');
const { geocodeAddress } = require('./geocodingService');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { z } = require('zod');
const validate = require('./validate');

// Configure S3 and Multer for thumbnail uploads
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

const uploadThumbnail = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.AWS_S3_BUCKET_NAME,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, `trucks/thumbnails/${uniqueSuffix}-${file.originalname}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (validTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file format. Only JPEG, PNG, GIF, or WebP are allowed.'));
        }
    }
});

const truckRegistrationSchema = z.object({
    truckName: z.string().min(1, 'Truck name is required.'),
    truckType: z.enum(['flatbed', 'dry_van', 'reefer', 'other']),
    homeBase: z.string().min(1, 'Home base location is required.'),
    capacity: z.coerce.number().positive().optional(),
});

/**
 * @route   POST /api/trucks/register
 * @desc    Register a new truck for the authenticated user.
 * @access  Private
 */
router.post('/register', protect, uploadThumbnail.single('thumbnail'), validate({ body: truckRegistrationSchema }), async (req, res) => {
    const { truckName, truckType, homeBase, capacity } = req.body;
    const ownerId = req.user.id;
    const thumbnailUrl = req.file ? req.file.location : null;
    try {
        const coordinates = await geocodeAddress(homeBase);
        const longitude = coordinates ? coordinates[0] : null;
        const latitude = coordinates ? coordinates[1] : null;
        const query = `
            INSERT INTO trucks (name, type, capacity, home_base, thumbnail_url, owner_id, home_base_lng, home_base_lat)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *;
        `;
        const values = [truckName, truckType, capacity, homeBase, thumbnailUrl, ownerId, longitude, latitude];
        const { rows } = await pool.query(query, values);
        res.status(201).json({
            message: 'Truck registered successfully!',
            data: rows[0]
        });
    } catch (error) {
        console.error('Truck Registration Error:', error);
        res.status(500).json({ message: 'Internal server error during truck registration.' });
    }
});

/**
 * @route   GET /api/trucks/me
 * @desc    Get paginated trucks for the authenticated user.
 * @access  Private
 */
router.get('/me', protect, async (req, res) => {
    const ownerId = req.user.id;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 15;
    const offset = (page - 1) * limit;

    try {
        const { rows: countRows } = await pool.query('SELECT COUNT(id) FROM trucks WHERE owner_id = $1', [ownerId]);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit);

        const { rows } = await pool.query('SELECT * FROM trucks WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [ownerId, limit, offset]);
        res.status(200).json({ data: rows, pagination: { currentPage: page, totalPages, totalItems } });
    } catch (error) {
        console.error('Fetch My Trucks Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

/**
 * @route   PUT /api/trucks/:id
 * @desc    Update a truck.
 * @access  Private
 */
router.put('/:id', protect, uploadThumbnail.single('thumbnail'), async (req, res) => {
    const truckId = req.params.id;
    const ownerId = req.user.id;
    const { truckName, truckType, homeBase, capacity } = req.body;
    const thumbnailUrl = req.file ? req.file.location : null;

    try {
        const truckQuery = await pool.query('SELECT owner_id, thumbnail_url FROM trucks WHERE id = $1', [truckId]);
        const truck = truckQuery.rows[0];
        
        if (!truck) return res.status(404).json({ message: 'Truck not found.' });
        if (truck.owner_id !== ownerId) return res.status(403).json({ message: 'Not authorized to update this truck.' });

        if (thumbnailUrl && truck.thumbnail_url) {
            const urlObj = new URL(truck.thumbnail_url);
            const key = urlObj.pathname.substring(1);
            await s3.send(new DeleteObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Key: decodeURIComponent(key)
            }));
        }

        const newThumbnail = thumbnailUrl || truck.thumbnail_url;
        const { rows } = await pool.query(
            'UPDATE trucks SET name = $1, type = $2, capacity = $3, home_base = $4, thumbnail_url = $5 WHERE id = $6 RETURNING *',
            [truckName, truckType, capacity, homeBase, newThumbnail, truckId]
        );

        res.status(200).json({ message: 'Truck updated successfully.', data: rows[0] });
    } catch (error) {
        console.error('Update Truck Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

/**
 * @route   DELETE /api/trucks/:id
 * @desc    Delete a truck.
 * @access  Private
 */
router.delete('/:id', protect, async (req, res) => {
    const truckId = req.params.id;
    const ownerId = req.user.id;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const truckQuery = await client.query('SELECT owner_id, thumbnail_url FROM trucks WHERE id = $1', [truckId]);
        const truck = truckQuery.rows[0];

        if (!truck) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Truck not found.' });
        }
        if (truck.owner_id !== ownerId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'Not authorized.' });
        }

        if (truck.thumbnail_url) {
            const urlObj = new URL(truck.thumbnail_url);
            const key = urlObj.pathname.substring(1);
            await s3.send(new DeleteObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Key: decodeURIComponent(key)
            }));
        }

        await client.query('DELETE FROM trucks WHERE id = $1', [truckId]);
        await client.query('COMMIT');

        res.status(200).json({ message: `Truck ID ${truckId} deleted successfully.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete Truck Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    } finally {
        client.release();
    }
});

/**
 * @route   PATCH /api/trucks/:id/availability
 * @desc    Update truck availability.
 * @access  Private
 */
router.patch('/:id/availability', protect, async (req, res) => {
    const truckId = req.params.id;
    const ownerId = req.user.id;
    const { isAvailable } = req.body;

    try {
        const { rows } = await pool.query(
            'UPDATE trucks SET is_available = $1 WHERE id = $2 AND owner_id = $3 RETURNING id, name, is_available',
            [isAvailable, truckId, ownerId]
        );

        if (rows.length === 0) return res.status(404).json({ message: 'Truck not found or not authorized.' });

        res.status(200).json({ message: `Truck status updated to ${isAvailable ? 'available' : 'unavailable'}.`, data: rows[0] });
    } catch (error) {
        console.error('Availability Update Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

/**
 * @route   POST /api/trucks/find
 * @desc    Find available trucks.
 * @access  Public
 */
router.post('/find', async (req, res) => {
    const { truckType } = req.body;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = (page - 1) * limit;

    try {
        let countQuery = 'SELECT COUNT(id) FROM trucks WHERE is_available = true';
        let queryStr = 'SELECT * FROM trucks WHERE is_available = true';
        const queryParams = [];

        if (truckType) {
            countQuery += ' AND type = $1';
            queryStr += ' AND type = $1';
            queryParams.push(truckType);
        }

        const { rows: countRows } = await pool.query(countQuery, queryParams);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit);

        queryStr += ` ORDER BY created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
        queryParams.push(limit, offset);

        const { rows } = await pool.query(queryStr, queryParams);

        res.status(200).json({ data: rows, pagination: { currentPage: page, totalPages, totalItems } });
    } catch (error) {
        console.error('Find Trucks Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

module.exports = router;