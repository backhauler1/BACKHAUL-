const webPush = require('web-push');
const pool = require('./db');

// Configure web-push with your VAPID keys
webPush.setVapidDetails(
    'mailto:support@yourdomain.com',
    process.env.PUBLIC_VAPID_KEY,
    process.env.PRIVATE_VAPID_KEY
);

/**
 * Sends a push notification and cleans up expired/revoked subscriptions.
 * @param {number} userId - The ID of the user to notify.
 * @param {Object} payload - The notification payload (title, body, url).
 */
async function sendPushNotification(userId, payload) {
    try {
        const result = await pool.query('SELECT push_subscription FROM users WHERE id = $1 AND push_subscription IS NOT NULL', [userId]);
        
        if (result.rows.length === 0) {
            return; // No subscription found for this user
        }

        const subscription = result.rows[0].push_subscription;
        await webPush.sendNotification(subscription, JSON.stringify(payload));
        
    } catch (error) {
        // HTTP status 404 or 410 means the subscription has expired or the user revoked permission
        if (error.statusCode === 404 || error.statusCode === 410) {
            console.log(`Push subscription expired for user ${userId}. Removing from database.`);
            await pool.query('UPDATE users SET push_subscription = NULL WHERE id = $1', [userId]);
        } else {
            console.error('Error sending push notification:', error);
        }
    }
}

module.exports = { sendPushNotification };