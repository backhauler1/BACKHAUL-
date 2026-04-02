const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const logger = require('./logger');
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
 * Handles the logic for uploading a Base64 encoded image to S3 and returning the object key.
 * @param {string} base64Image - The Base64 data URL from the client.
 * @returns {Promise<string>} The S3 object key.
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
    });

    await s3.send(command);

    // Return the key to store in the database instead of a public URL
    return key;
}

/**
 * Generates a temporary signed URL for a given S3 key.
 * @param {string} key - The S3 object key.
 * @returns {Promise<string>} The temporary signed URL.
 */
async function generateSignedUrl(key) {
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
    });
    // URL expires in 1 hour (3600 seconds)
    return await getSignedUrl(s3, command, { expiresIn: 3600 });
}

/**
 * Processes an array of message objects, generating signed URLs for any with image keys.
 * @param {Array<Object>} messages - The array of message rows from the database.
 * @returns {Promise<Array<Object>>}
 */
async function processMessagesWithSignedUrls(messages) {
    // Use Promise.all for concurrent URL generation
    return Promise.all(messages.map(async (msg) => {
        const newMsg = { ...msg }; // Create a shallow copy to avoid mutation
        if (newMsg.image_url) {
            try {
                newMsg.image = await generateSignedUrl(newMsg.image_url);
            } catch (urlError) {
                logger.error('Failed to generate signed URL for key:', { key: newMsg.image_url, error: urlError.message });
                newMsg.image = null; // Ensure image is null on error
            }
        }
        delete newMsg.image_url; // Remove the key before sending to client
        return newMsg;
    }));
}

/**
 * Initializes all Socket.IO event handlers for the chat.
 * @param {import('socket.io').Server} io - The Socket.IO server instance.
 */
function initializeSocketHandlers(io) {
    io.on('connection', (socket) => {

        socket.on('send_message', async (data) => {
            const { room, content, sender_id, receiver_id, image } = data;

            try {
                let imageKey = null;
                let signedUrl = null;
                if (image) {
                    imageKey = await uploadImageToS3(image);
                    signedUrl = await generateSignedUrl(imageKey);
                }

                const insertQuery = `
                    INSERT INTO messages (sender_id, receiver_id, content, image_url)
                    VALUES ($1, $2, $3, $4)
                    RETURNING id, content, image_url, sender_id, receiver_id, created_at as timestamp, read_at;
                `;
                
                const { rows } = await pool.query(insertQuery, [sender_id, receiver_id, content || null, imageKey]);
                const newMessage = { ...rows[0], image: signedUrl };
                delete newMessage.image_url;

                io.to(room).emit('message', newMessage);
            } catch (error) {
                logger.error('Error handling send_message:', { error: error.message, stack: error.stack });
                socket.emit('send_message_error', { message: 'Could not send your message.' });
            }
        });

        socket.on('join', async ({ room }) => {
            socket.join(room);
            try {
                const [user1, user2] = room.split('_');
                if (user1 && user2) {
                    const historyQuery = await pool.query(
                        `SELECT * FROM (
                            SELECT id, sender_id, receiver_id, content, image_url, created_at AS timestamp, read_at
                            FROM messages 
                            WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
                            ORDER BY created_at DESC LIMIT 50
                         ) AS sub ORDER BY timestamp ASC`,
                        [user1, user2]
                    );

                    const processedHistory = await processMessagesWithSignedUrls(historyQuery.rows);
                    processedHistory.forEach(msg => socket.emit('message', msg));
                }
            } catch (error) {
                logger.error('Failed to fetch chat history:', { error: error.message });
            }
        });

        socket.on('load_older_messages', async ({ room, beforeTimestamp }) => {
            try {
                const [user1, user2] = room.split('_');
                if (user1 && user2 && beforeTimestamp) {
                    const olderQuery = await pool.query(
                        `SELECT * FROM (
                            SELECT id, sender_id, receiver_id, content, image_url, created_at AS timestamp, read_at
                            FROM messages 
                            WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
                              AND created_at < $3
                            ORDER BY created_at DESC LIMIT 50
                         ) AS sub ORDER BY timestamp ASC`,
                        [user1, user2, beforeTimestamp]
                    );
                    const processedOlder = await processMessagesWithSignedUrls(olderQuery.rows);
                    socket.emit('older_messages', processedOlder);
                }
            } catch (error) {
                logger.error('Failed to fetch older chat messages:', { error: error.message });
            }
        });

        socket.on('mark_as_read', async ({ messageIds, room, readerId }) => {
            if (!messageIds || messageIds.length === 0) return;
            try {
                await pool.query(
                    'UPDATE messages SET read_at = NOW() WHERE id = ANY($1) AND receiver_id = $2 AND read_at IS NULL',
                    [messageIds, readerId]
                );
                io.to(room).emit('messages_read', { messageIds });
            } catch (error) {
                logger.error('Failed to mark messages as read:', { error: error.message });
            }
        });

        socket.on('typing_status', (data) => {
            socket.to(data.room).emit('typing_status', data);
        });
    });
}

module.exports = { initializeSocketHandlers };