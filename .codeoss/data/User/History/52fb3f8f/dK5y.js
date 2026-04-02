const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const router = express.Router();
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
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
const { uploadLimiter, searchLimiter } = require('../rateLimiter'); // Adjust the path if necessary based on your folder structure

// Initialize the S3 Client
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Initialize the Mapbox Geocoding client
const geocodingService = mbxGeocoding({ accessToken: process.env.MAPBOX_TOKEN });

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

const documentSchema = z.object({
    documentType: z.string({ required_error: 'Document type is required.' }),
    expiresAt: z.string().optional()
});

const docStorage = multerS3({
    s3: s3,
    bucket: process.env.AWS_S3_BUCKET_NAME,
    acl: 'private',
    metadata: function (req, file, cb) {
        cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
        const uniqueSuffix = crypto.randomBytes(16).toString('hex');
        const ext = path.extname(file.originalname);
        cb(null, `companies/documents/doc-${uniqueSuffix}${ext}`);
    }
});

const docFileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('INVALID_DOC_TYPE'), false);
    }
};

const docUpload = multer({ 
    storage: docStorage,
    fileFilter: docFileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Define the Zod schema for company text fields
const companyTextSchema = z.object({
    companyName: z.string({ required_error: 'Company name is required.' }).min(1, 'Company name is required.'),
    description: z.string().optional(),
    services: z.string().optional(),
    location: z.string().optional(),
    // This ensures the checkbox was checked. The frontend sends 'on' for a checked checkbox in FormData.
    privacyPolicy: z.literal('on', {
        errorMap: () => ({ message: 'You must agree to the Privacy Policy and Terms of Service.' }),
    }),
});

// Define a Zod schema for pagination and search query parameters
const listQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(50).default(15),
    search: z.string().optional(),
});

// 4. Define the POST endpoint
// 'thumbnail' matches the name attribute of the file input in your HTML form
// We add the `protect` middleware here. It runs before the main route handler.
// If the user isn't authenticated, it sends a 401 response and stops execution.
// It also attaches the user data to `req.user`, making the manual check unnecessary.
router.post('/register', protect, authorize('admin'), uploadLimiter, upload.single('thumbnail'), validate({ body: companyTextSchema }), async (req, res) => {
    try {
        // Extract the text fields sent alongside the file
        const { companyName, description, services, location } = req.body;
        
        let thumbnailUrl = null;
        if (req.file) {
            // multer-s3 automatically provides the full S3 URL in req.file.location
            thumbnailUrl = req.file.location;
        }
        
        let lng = null;
        let lat = null;
        if (location) {
            try {
                const geoResponse = await geocodingService.forwardGeocode({ query: location, limit: 1 }).send();
                if (geoResponse && geoResponse.body && geoResponse.body.features && geoResponse.body.features.length > 0) {
                    [lng, lat] = geoResponse.body.features[0].center;
                }
            } catch (geocodeError) {
                console.error('Geocoding failed for company registration:', geocodeError.message);
            }
        }

        // Convert the comma-separated services string into a PostgreSQL text array
        const servicesArray = services ? services.split(',').map(s => s.trim()) : [];

        // Use RETURNING * to get the newly created record back from the database
        const newCompanyQuery = await pool.query(
            `INSERT INTO companies (name, description, services, location, thumbnail_url, owner_id, privacy_policy_agreed_at, lng, lat) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8) 
             RETURNING *`,
            [companyName, description, servicesArray, location, thumbnailUrl, req.user.id, lng, lat]
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

// 7. Route for admins to get a paginated list of all companies
router.get('/', protect, authorize('admin'), validate({ query: listQuerySchema }), async (req, res) => {
    const { page, limit, search } = req.query;
    const offset = (page - 1) * limit;

    try {
        let countQuery = `
            SELECT COUNT(c.id) 
            FROM companies c
            LEFT JOIN users u ON c.owner_id = u.id
        `;
        let queryStr = `
            SELECT 
                c.id, 
                c.name, 
                c.created_at, 
                c.privacy_policy_agreed_at,
                c.is_suspended,
                u.id as owner_id,
                u.name as owner_name,
                u.email as owner_email
            FROM companies c
            LEFT JOIN users u ON c.owner_id = u.id
        `;
        
        const countParams = [];
        const queryParams = [];
        let paramIndex = 1;

        if (search) {
            const whereClause = ` WHERE c.name ILIKE $${paramIndex} OR u.name ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex}`;
            countQuery += whereClause;
            queryStr += whereClause;
            const searchTerm = `%${search}%`;
            countParams.push(searchTerm);
            queryParams.push(searchTerm);
            paramIndex++;
        }

        const { rows: countRows } = await pool.query(countQuery, countParams);
        const totalItems = parseInt(countRows[0].count, 10);
        const totalPages = Math.ceil(totalItems / limit) || 1;

        queryStr += ` ORDER BY c.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        queryParams.push(limit, offset);

        const { rows: companies } = await pool.query(queryStr, queryParams);

        res.status(200).json({
            data: companies,
            pagination: { currentPage: page, totalPages, totalItems }
        });
    } catch (error) {
        console.error('Fetch Companies Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching companies.' });
    }
});

// 9. Route for admins to suspend/unsuspend a company
const suspendSchema = z.object({
    suspend: z.boolean()
});

router.patch('/:id/suspend', protect, authorize('admin'), validate({ params: numericParamSchema('id'), body: suspendSchema }), async (req, res) => {
    const companyId = req.params.id;
    const { suspend } = req.body;

    try {
        const updateQuery = await pool.query(
            'UPDATE companies SET is_suspended = $1 WHERE id = $2 RETURNING id, name, is_suspended',
            [suspend, companyId]
        );

        if (updateQuery.rows.length === 0) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        const action = suspend ? 'suspended' : 'unsuspended';
        res.status(200).json({ message: `Company successfully ${action}.` });
    } catch (error) {
        console.error('Suspend Company Error:', error);
        res.status(500).json({ message: 'Internal server error while updating suspension status.' });
    }
});

// 8. Route for admins to delete a company and its S3 thumbnail
router.delete('/:id', protect, authorize('admin'), validate({ params: numericParamSchema('id') }), async (req, res) => {
    const companyId = req.params.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Get the company record to find the thumbnail URL
        const companyQuery = await client.query('SELECT thumbnail_url FROM companies WHERE id = $1', [companyId]);
        const company = companyQuery.rows[0];

        if (!company) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Company not found.' });
        }

        // 2. If a thumbnail exists, delete it from S3
        if (company.thumbnail_url) {
            try {
                const urlObj = new URL(company.thumbnail_url);
                const key = decodeURIComponent(urlObj.pathname.substring(1)); // Remove leading slash

                await s3.send(new DeleteObjectCommand({
                    Bucket: process.env.AWS_S3_BUCKET_NAME,
                    Key: key,
                }));
                console.log(`Deleted thumbnail from S3: ${key}`);
            } catch (s3Error) {
                console.error(`Failed to delete thumbnail from S3 for company ${companyId}:`, s3Error);
                // Log the error but don't block the DB deletion
            }
        }

        // 3. Delete the company from the database
        await client.query('DELETE FROM companies WHERE id = $1', [companyId]);

        await client.query('COMMIT');
        res.status(200).json({ message: `Company ID ${companyId} and associated thumbnail deleted successfully.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete Company Error:', error);
        // Check for foreign key constraint errors if other tables reference companies
        if (error.code === '23503') {
            return res.status(409).json({ message: 'Cannot delete company. It has associated records (e.g., loads) that must be removed first.' });
        }
        res.status(500).json({ message: 'Internal server error during deletion.' });
    } finally {
        client.release();
    }
});

// Public route for finding companies, used by the main search form
const findCompanySchema = z.object({
    'search-term': z.string().optional(),
}).passthrough();

router.post('/find', validate({ body: findCompanySchema }), async (req, res) => {
router.post('/find', searchLimiter, validate({ body: findCompanySchema }), async (req, res) => {
    const searchTerm = req.body['search-term'];

    try {
        // This query now returns coordinates and the suspension status
        let queryStr = `
            SELECT id, name, description, services, thumbnail_url, location, is_suspended, lng, lat 
            FROM companies
        `;
        const queryParams = [];
        let paramIndex = 1;

        // Always filter out suspended companies from public search results.
        queryStr += ` WHERE is_suspended = false`;

        if (searchTerm) {
            queryStr += ` AND name ILIKE $${paramIndex}`;
            queryParams.push(`%${searchTerm}%`);
        }

        queryStr += ` ORDER BY name ASC LIMIT 50`;

        const { rows: companies } = await pool.query(queryStr, queryParams);

        res.status(200).json({ data: companies });

    } catch (error) {
        console.error('Find Companies Error:', error);
        res.status(500).json({ message: 'Internal server error while searching for companies.' });
    }
});

// 10. Route to upload compliance documents
router.post('/:id/documents', protect, uploadLimiter, docUpload.single('document'), validate({ params: numericParamSchema('id'), body: documentSchema }), async (req, res) => {
    const companyId = req.params.id;
    const userId = req.user.id;
    const { documentType, expiresAt } = req.body;

    if (!req.file) {
        return res.status(400).json({ message: 'No document file uploaded.' });
    }

    try {
        const companyQuery = await pool.query('SELECT owner_id FROM companies WHERE id = $1', [companyId]);
        const company = companyQuery.rows[0];

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        if (company.owner_id !== userId && !req.user.roles.includes('admin')) {
            return res.status(403).json({ message: 'Not authorized to upload documents for this company.' });
        }

        const fileUrl = req.file.location;

        const newDocQuery = await pool.query(
            `INSERT INTO company_documents (company_id, document_type, file_url, expires_at)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [companyId, documentType, fileUrl, expiresAt || null]
        );

        res.status(201).json({ message: 'Document uploaded successfully.', data: newDocQuery.rows[0] });
    } catch (error) {
        console.error('Upload Document Error:', error);
        res.status(500).json({ message: 'Internal server error during document upload.' });
    }
});

// 11. Route to get compliance documents
router.get('/:id/documents', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const companyId = req.params.id;

    try {
        const docsQuery = await pool.query(
            `SELECT id, document_type, expires_at, is_verified, uploaded_at 
             FROM company_documents 
             WHERE company_id = $1
             ORDER BY uploaded_at DESC`,
            [companyId]
        );

        res.status(200).json({ data: docsQuery.rows });
    } catch (error) {
        console.error('Fetch Documents Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching documents.' });
    }
});

// 12. Route to delete compliance documents
router.delete('/:id/documents/:docId', protect, validate({ params: z.object({ id: z.coerce.number(), docId: z.coerce.number() }) }), async (req, res) => {
    const companyId = req.params.id;
    const docId = req.params.docId;
    const userId = req.user.id;

    try {
        const companyQuery = await pool.query('SELECT owner_id FROM companies WHERE id = $1', [companyId]);
        const company = companyQuery.rows[0];

        if (!company || (company.owner_id !== userId && !req.user.roles.includes('admin'))) {
            return res.status(403).json({ message: 'Not authorized.' });
        }

        const docQuery = await pool.query('SELECT file_url FROM company_documents WHERE id = $1 AND company_id = $2', [docId, companyId]);
        const doc = docQuery.rows[0];

        if (!doc) {
            return res.status(404).json({ message: 'Document not found.' });
        }

        try {
            const urlObj = new URL(doc.file_url);
            const key = decodeURIComponent(urlObj.pathname.substring(1));
            await s3.send(new DeleteObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Key: key,
            }));
        } catch (s3Error) {
            console.error('Failed to delete document from S3:', s3Error);
        }

        await pool.query('DELETE FROM company_documents WHERE id = $1', [docId]);

        res.status(200).json({ message: 'Document deleted successfully.' });
    } catch (error) {
        console.error('Delete Document Error:', error);
        res.status(500).json({ message: 'Internal server error during document deletion.' });
    }
});

// 13. Route to verify document (Admin only)
const verifyDocSchema = z.object({
    is_verified: z.boolean()
});

router.patch('/:id/documents/:docId/verify', protect, authorize('admin'), validate({ params: z.object({ id: z.coerce.number(), docId: z.coerce.number() }), body: verifyDocSchema }), async (req, res) => {
    const { docId } = req.params;
    const { is_verified } = req.body;

    try {
        const updateQuery = await pool.query(
            'UPDATE company_documents SET is_verified = $1 WHERE id = $2 RETURNING *',
            [is_verified, docId]
        );

        if (updateQuery.rows.length === 0) {
            return res.status(404).json({ message: 'Document not found.' });
        }

        res.status(200).json({ message: 'Document verification status updated.', data: updateQuery.rows[0] });
    } catch (error) {
        console.error('Verify Document Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 6. Handle Multer-specific errors cleanly
router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'File is too large.' });
    } else if (error.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ message: 'Invalid file format. Please upload a JPEG, PNG, GIF, or WebP.' });
    } else if (error.message === 'INVALID_DOC_TYPE') {
        return res.status(400).json({ message: 'Invalid document format. Please upload a PDF, JPEG, or PNG.' });
    }
    
    next(error); // Pass unhandled errors to the default Express error handler
});

module.exports = router;