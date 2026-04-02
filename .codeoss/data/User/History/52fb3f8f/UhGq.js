const express = require('express');
const router = express.Router();
const pool = require('./db');
const { protect, authorize } = require('./auth');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
        const documentType = req.body.documentType || 'Other';

        const { rows } = await pool.query(
            `INSERT INTO company_documents (company_id, document_name, document_url, document_type, uploaded_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
            [companyId, documentName, documentUrl, documentType]
        );

        res.status(201).json({ message: 'Document uploaded successfully.', data: rows[0] });
    } catch (error) {
        console.error('Company Document Upload Error:', error);
        res.status(500).json({ message: 'Internal server error while uploading the document.' });
    }
});

/**
 * GET /api/companies/:id/documents
 * Retrieves the list of compliance documents for a specific company.
 */
router.get('/:id/documents', protect, validate({ params: numericParamSchema('id') }), async (req, res) => {
    const companyId = req.params.id;

    try {
        const queryStr = `
            SELECT id, document_name, document_type, document_url as file_url, uploaded_at, expires_at, is_verified 
            FROM company_documents 
            WHERE company_id = $1
            ORDER BY uploaded_at DESC
        `;
        const { rows: documents } = await pool.query(queryStr, [companyId]);

        res.status(200).json({ data: documents });
    } catch (error) {
        console.error('Fetch Company Documents Error:', error);
        res.status(500).json({ message: 'Internal server error while fetching documents.' });
    }
});

/**
 * DELETE /api/companies/:id/documents/:docId
 * Deletes a specific compliance document and removes it from S3.
 */
router.delete('/:id/documents/:docId', protect, async (req, res) => {
    const companyId = req.params.id;
    const docId = req.params.docId;
    const userId = req.user.id;

    try {
        // 1. Verify ownership/admin rights
        const companyQuery = await pool.query('SELECT owner_id FROM companies WHERE id = $1', [companyId]);
        const company = companyQuery.rows[0];

        if (!company || (company.owner_id !== userId && !(req.user.roles && req.user.roles.includes('admin')))) {
            return res.status(403).json({ message: 'Not authorized to delete documents for this company.' });
        }

        // 2. Get the file URL to extract the S3 key
        const docQuery = await pool.query('SELECT document_url as file_url FROM company_documents WHERE id = $1 AND company_id = $2', [docId, companyId]);
        const doc = docQuery.rows[0];

        if (!doc) {
            return res.status(404).json({ message: 'Document not found.' });
        }

        // 3. Delete from the database
        await pool.query('DELETE FROM company_documents WHERE id = $1', [docId]);

        // 4. Delete the file from S3
        if (doc.file_url) {
            const urlObj = new URL(doc.file_url);
            const key = urlObj.pathname.substring(1); // Remove leading slash
            
            await s3.send(new DeleteObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Key: decodeURIComponent(key)
            }));
        }

        res.status(200).json({ message: 'Document deleted successfully.' });
    } catch (error) {
        console.error('Delete Document Error:', error);
        res.status(500).json({ message: 'Internal server error while deleting document.' });
    }
});

/**
 * PATCH /api/companies/:id/documents/:docId/verify
 * Allows an admin to verify a document.
 */
router.patch('/:id/documents/:docId/verify', protect, authorize('admin'), async (req, res) => {
    const companyId = req.params.id;
    const docId = req.params.docId;
    const { is_verified } = req.body;

    try {
        const updateQuery = `
            UPDATE company_documents 
            SET is_verified = $1 
            WHERE id = $2 AND company_id = $3
            RETURNING id, is_verified
        `;
        const { rows } = await pool.query(updateQuery, [is_verified, docId, companyId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Document not found.' });
        }

        res.status(200).json({ message: 'Document verification updated.', data: rows[0] });
    } catch (error) {
        console.error('Verify Document Error:', error);
        res.status(500).json({ message: 'Internal server error while verifying document.' });
    }
});

module.exports = router;