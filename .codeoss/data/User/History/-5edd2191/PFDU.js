import { apiFetch } from './apiUtil.js';

// Ensure you replace this with your actual public key
const PUBLIC_VAPID_KEY = 'process.env.PUBLIC_VAPID_KEY';

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

/**
 * Contextually asks the user for push notification permission and saves the subscription.
 */
export async function promptPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    // Only prompt if they haven't explicitly allowed or denied yet
    if (Notification.permission === 'granted' || Notification.permission === 'denied') return;

    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY)
            });

            await apiFetch('/api/push/subscribe', { method: 'POST', body: subscription });
        }
    } catch (error) {
        console.error('Failed to subscribe to push notifications:', error);
    }
}