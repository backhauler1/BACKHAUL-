const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const router = express.Router();

// Assumes you have a `db.js` file that sets up and exports the pg Pool.
// Example: const { Pool } = require('pg'); module.exports = new Pool();
const pool = require('../db'); 

// 1. Configure Secure Storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure this directory exists on your server!
        cb(null, 'uploads/companies/thumbnails/'); 
    },
    filename: function (req, file, cb) {
        // Generate a random string to prevent filename collisions and directory traversal
        const uniqueSuffix = crypto.randomBytes(16).toString('hex');
        const ext = path.extname(file.originalname);
        cb(null, `company-${uniqueSuffix}${ext}`);
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

// 4. Define the POST endpoint
// 'thumbnail' matches the name attribute of the file input in your HTML form
router.post('/register', upload.single('thumbnail'), async (req, res) => {
    // NOTE: This assumes you have an authentication middleware that runs before this route
    // and attaches the logged-in user's info to `req.user`.
    if (!req.user || !req.user.id) {
        return res.status(401).json({ message: 'You must be logged in to register a company.' });
    }
    try {
        // Extract the text fields sent alongside the file
        const { companyName, description, services, location } = req.body;
        
        let thumbnailUrl = null;
        if (req.file) {
            // Store the relative path so the frontend can render it
            thumbnailUrl = `/uploads/companies/thumbnails/${req.file.filename}`;
        }

        // TODO: Save this data to your database
        /*
        const newCompany = await db.query(
            'INSERT INTO companies (name, description, services, location, thumbnail_url) VALUES ($1, $2, $3, $4, $5)',
            [companyName, description, services, location, thumbnailUrl]
        // Convert the comma-separated services string into a PostgreSQL text array
        const servicesArray = services ? services.split(',').map(s => s.trim()) : [];

        // Use RETURNING * to get the newly created record back from the database
        const newCompanyQuery = await pool.query(
            `INSERT INTO companies (name, description, services, location, thumbnail_url, owner_id) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             RETURNING *`,
            [companyName, description, servicesArray, location, thumbnailUrl, req.user.id]
        );
        */

        const newCompany = newCompanyQuery.rows[0];

        res.status(201).json({ 
            message: 'Company registered successfully!',
            // data: newCompany
            // Send the newly created company data back to the client
            data: newCompany
        });

    } catch (error) {
        console.error('Registration Error:', error);
        res.status(500).json({ message: 'Internal server error during registration.' });
    }
});

// 5. Handle Multer-specific errors cleanly
router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'File is too large. Maximum size is 5MB.' });
    } else if (error.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ message: 'Invalid file format. Please upload a JPEG, PNG, GIF, or WebP.' });
    }
    
    next(error); // Pass unhandled errors to the default Express error handler
});

module.exports = router;