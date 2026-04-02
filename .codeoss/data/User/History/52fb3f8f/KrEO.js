const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const router = express.Router();
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');
const validate = require('../validate'); // Adjust the path depending on your folder structure
const { numericParamSchema } = require('../commonSchemas'); // Adjust the path depending on your folder structure
const { z } = require('zod');

// Import the protection middleware. This assumes you created the file in a `middleware` directory.
const { protect, authorize } = require('../middleware/auth');

// Assumes you have a `db.js` file that sets up and exports the pg Pool.
// Example: const { Pool } = require('pg'); module.exports = new Pool();
const pool = require('../db'); 
const { uploadLimiter } = require('../rateLimiter'); // Adjust the path if necessary based on your folder structure

// Initialize the S3 Client
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// 1. Configure Secure S3 Storage
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
        cb(null, `companies/thumbnails/company-${uniqueSuffix}${ext}`);
    }
});

// 2. Configure Strict File Filter
const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        // Reject the file if it doesn't match allowed types
        cb(new Error('INVALID_FILE_TYPE'), false);
    }
};

// 3. Initialize Multer with Storage, Filters, and Limits
const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5 MB limit
    }
});

// Define the Zod schema for company text fields
const companyTextSchema = z.object({
    companyName: z.string({ required_error: 'Company name is required.' }).min(1, 'Company name is required.'),
    description: z.string().optional(),
    services: z.string().optional(),
    location: z.string().optional()
});

// 4. Define the POST endpoint
// 'thumbnail' matches the name attribute of the file input in your HTML form
// We add the `protect` middleware here. It runs before the main route handler.
// If the user isn't authenticated, it sends a 401 response and stops execution.
// It also attaches the user data to `req.user`, making the manual check unnecessary.
router.post('/register', protect, authorize('admin'), uploadLimiter, upload.single('thumbnail'), async (req, res) => {
router.post('/register', protect, authorize('admin'), uploadLimiter, upload.single('thumbnail'), validate({ body: companyTextSchema }), async (req, res) => {
    try {
        // Extract the text fields sent alongside the file
        const { companyName, description, services, location } = req.body;
        
        let thumbnailUrl = null;
        if (req.file) {
            // multer-s3 automatically provides the full S3 URL in req.file.location
            thumbnailUrl = req.file.location;
        }

        // Convert the comma-separated services string into a PostgreSQL text array
        const servicesArray = services ? services.split(',').map(s => s.trim()) : [];

        // Use RETURNING * to get the newly created record back from the database
        const newCompanyQuery = await pool.query(
            `INSERT INTO companies (name, description, services, location, thumbnail_url, owner_id) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             RETURNING *`,
            [companyName, description, servicesArray, location, thumbnailUrl, req.user.id]
        );

        const newCompany = newCompanyQuery.rows[0];

        res.status(201).json({ 
            message: 'Company registered successfully!',
            // Send the newly created company data back to the client
            data: newCompany
        });

    } catch (error) {
        console.error('Registration Error:', error);
        res.status(500).json({ message: 'Internal server error during registration.' });
    }
});

// 5. Route to update a company profile and delete the old thumbnail from S3
router.put('/:id', protect, validate({ params: numericParamSchema('id') }), uploadLimiter, upload.single('thumbnail'), async (req, res) => {
router.put('/:id', protect, validate({ params: numericParamSchema('id') }), uploadLimiter, upload.single('thumbnail'), validate({ body: companyTextSchema }), async (req, res) => {
    const companyId = req.params.id;
    const userId = req.user.id;

    try {
        // 1. Get the current company record to find the old thumbnail URL and verify ownership
        const companyQuery = await pool.query('SELECT thumbnail_url, owner_id FROM companies WHERE id = $1', [companyId]);
        const company = companyQuery.rows[0];

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        // Allow updates only by the owner or an admin
        if (company.owner_id !== userId && !req.user.roles.includes('admin')) {
            return res.status(403).json({ message: 'Not authorized to update this company.' });
        }

        let newThumbnailUrl = company.thumbnail_url;

        // 2. If a new file was uploaded, update the URL and delete the old file from S3
        if (req.file) {
            newThumbnailUrl = req.file.location;

            if (company.thumbnail_url) {
                try {
                    // Extract the S3 object key from the old URL
                    const urlObj = new URL(company.thumbnail_url);
                    const oldKey = decodeURIComponent(urlObj.pathname.substring(1)); // Remove leading slash

                    await s3.send(new DeleteObjectCommand({
                        Bucket: process.env.AWS_S3_BUCKET_NAME,
                        Key: oldKey,
                    }));
                    console.log(`Deleted old thumbnail from S3: ${oldKey}`);
                } catch (s3Error) {
                    console.error('Failed to delete old thumbnail from S3:', s3Error);
                    // We continue with the update even if deletion fails to not block the user
                }
            }
        }

        // 3. Process text fields and update the database
        const { companyName, description, services, location } = req.body;
        const servicesArray = services ? services.split(',').map(s => s.trim()) : undefined;

        const updateQuery = await pool.query(
            `UPDATE companies 
             SET name = COALESCE($1, name), description = COALESCE($2, description), 
                 services = COALESCE($3, services), location = COALESCE($4, location), 
                 thumbnail_url = $5
             WHERE id = $6 RETURNING *`,
            [companyName, description, servicesArray, location, newThumbnailUrl, companyId]
        );

        res.status(200).json({ message: 'Company profile updated successfully.', data: updateQuery.rows[0] });
    } catch (error) {
        console.error('Update Company Error:', error);
        res.status(500).json({ message: 'Internal server error during update.' });
    }
});

// 6. Handle Multer-specific errors cleanly
router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'File is too large. Maximum size is 5MB.' });
    } else if (error.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ message: 'Invalid file format. Please upload a JPEG, PNG, GIF, or WebP.' });
    }
    
    next(error); // Pass unhandled errors to the default Express error handler
});

module.exports = router;