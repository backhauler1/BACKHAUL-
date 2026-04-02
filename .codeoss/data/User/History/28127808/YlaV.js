const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const pool = require('./db'); // Assumes db.js is in the parent directory

// Configure S3 client (ensure AWS environment variables are set in your .env file)
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});
const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;

/**
 * Handles the logic for uploading a Base64 encoded image to S3.
 * @param {string} base64Image - The Base64 data URL from the client.
 * @returns {Promise<string>} The public URL of the uploaded image.
 */
async function uploadImageToS3(base64Image) {
    if (!BUCKET_NAME) {
        throw new Error('AWS_S3_BUCKET_NAME environment variable not set.');
    }
    if (!base64Image || !base64Image.startsWith('data:image')) {
        throw new Error('Invalid image data provided.');
    }

    // Extract mime type and image data from Base64 string
    const matches = base64Image.match(/^data:(.+);base64,(.*)$/);
    if (!matches || matches.length !== 3) {
        throw new Error('Invalid Base64 image format.');
    }

    const mimeType = matches[1];
    const imageBuffer = Buffer.from(matches[2], 'base64');
    const fileExtension = mimeType.split('/')[1];
    const uniqueSuffix = crypto.randomBytes(16).toString('hex');
    const key = `chat-images/${uniqueSuffix}.${fileExtension}`;

    const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: imageBuffer,
        ContentType: mimeType,
        // ACL: 'public-read', // Note: Use this only if your bucket is not public by default. Modern best practice is to keep buckets private and serve content via a signed URL or a CDN.
    });

    await s3.send(command);

    // Construct the public URL.
    return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

/**
 * Initializes all Socket.IO event handlers for the chat.
 * @param {import('socket.io').Server} io - The Socket.IO server instance.
 */
function initializeSocketHandlers(io) {
    io.on('connection', (socket) => {

        // ... other handlers like 'join', 'load_older_messages', 'mark_as_read', 'typing_status' would be here ...

        socket.on('send_message', async (data) => {
            const { room, content, sender_id, receiver_id, image } = data;

            try {
                let imageUrl = null;
                if (image) {
                    imageUrl = await uploadImageToS3(image);
                }

                const insertQuery = `
                    INSERT INTO messages (sender_id, receiver_id, content, image_url)
                    VALUES ($1, $2, $3, $4)
                    RETURNING id, content, image_url, sender_id, receiver_id, created_at as timestamp, read_at;
                `;
                
                const { rows } = await pool.query(insertQuery, [sender_id, receiver_id, content || null, imageUrl]);
                const newMessage = { ...rows[0], image: rows[0].image_url }; // Map image_url to 'image' for the client
                delete newMessage.image_url;

                io.to(room).emit('message', newMessage);
            } catch (error) {
                console.error('Error handling send_message:', error);
                socket.emit('send_message_error', { message: 'Could not send your message.' });
            }
        });
    });
}

module.exports = { initializeSocketHandlers };
