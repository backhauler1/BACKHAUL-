const express = require('express');
const router = express.Router();
const pool = require('./db');
const { protect } = require('./auth');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const validate = require('./validate');
const { numericParamSchema } = require('./commonSchemas');

// Configure the AWS S3 Client
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// Configure Multer to upload files directly to S3
const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.AWS_S3_BUCKET_NAME,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: function (req, file, cb) {
            // Create a unique file name to prevent accidental overwrites
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, `companies/compliance/${uniqueSuffix}-${file.originalname}`);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit to match the frontend
    fileFilter: (req, file, cb) => {
        const validTypes = ['application/pdf', 'image/jpeg', 'image/png'];
        if (validTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PDF, JPEG, and PNG are allowed.'));
        }
    }
});

/**
 * POST /api/companies/:id/documents
 * Uploads a compliance document for a specific company.
 */
router.post('/:id/documents', protect, validate({ params: numericParamSchema('id') }), upload.single('document'), async (req, res) => {
    const companyId = req.params.id;
    const userId = req.user.id;

    if (!req.file) {
        return res.status(400).json({ message: 'No document uploaded. Please attach a valid file.' });
    }

    try {
        // 1. Verify the company exists and the user is authorized (owner or admin)
        const companyQuery = await pool.query('SELECT id, owner_id FROM companies WHERE id = $1', [companyId]);
        const company = companyQuery.rows[0];

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        if (company.owner_id !== userId && !(req.user.roles && req.user.roles.includes('admin'))) {
            return res.status(403).json({ message: 'You do not have permission to upload documents for this company.' });
        }

        // 2. Save the document reference into the database
        const documentUrl = req.file.location; // `location` is provided by multer-s3
        const documentName = req.file.originalname;

        await pool.query(
            `INSERT INTO company_documents (company_id, document_name, document_url, uploaded_at) VALUES ($1, $2, $3, NOW())`,
            [companyId, documentName, documentUrl]
        );

        res.status(201).json({ message: 'Document uploaded successfully!' });
    } catch (error) {
        console.error('Company Document Upload Error:', error);
        res.status(500).json({ message: 'Internal server error while uploading the document.' });
    }
});

module.exports = router;