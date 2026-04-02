const express = require('express');
const router = express.Router();
const pool = require('./db');
const { protect } = require('./auth');
const { geocodeAddress } = require('./geocodingService');
const { S3Client } = require('@aws-sdk/client-s3');
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

module.exports = router;