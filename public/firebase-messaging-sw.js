/* eslint-disable no-undef */
// Service Worker for Google Chrome & Firebase Cloud Messaging (FCM) Notifications

let messagingInstance = null;
let isFirebaseInitialized = false;

function initFirebaseInSW(config) {
  if (isFirebaseInitialized || !config || !config.apiKey || !config.projectId || !config.messagingSenderId || !config.appId) {
    return;
  }
  try {
    importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js');
    importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js');

    if (typeof firebase !== 'undefined' && !firebase.apps.length) {
      firebase.initializeApp({
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        storageBucket: config.storageBucket,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId,
      });

      messagingInstance = firebase.messaging();
      isFirebaseInitialized = true;

      messagingInstance.onBackgroundMessage((payload) => {
        const title = payload?.notification?.title || payload?.data?.title || 'جمعية أولاد سلطان';
        const body = payload?.notification?.body || payload?.data?.body || 'لديك إشعار جديد في التطبيق';
        const icon = payload?.notification?.icon || '/app-icon.jpg';

        return self.registration.showNotification(title, {
          body,
          icon,
          badge: '/app-icon.jpg',
          dir: 'rtl',
          lang: 'ar',
          tag: payload?.data?.tag || `fcm_${Date.now()}`,
          renotify: true,
          vibrate: [200, 100, 200],
          data: {
            url: payload?.data?.url || '/',
            bookingId: payload?.data?.bookingId || '',
          },
        });
      });
    }
  } catch (err) {
    console.warn('FCM Service Worker initialization warning:', err);
  }
}

// Attempt immediate initialization from SW registration query parameters
try {
  const params = new URL(self.location.href).searchParams;
  const apiKey = params.get('apiKey');
  const projectId = params.get('projectId');
  const messagingSenderId = params.get('messagingSenderId');
  const appId = params.get('appId');
  if (apiKey && projectId && messagingSenderId && appId) {
    initFirebaseInSW({
      apiKey,
      authDomain: params.get('authDomain') || undefined,
      projectId,
      storageBucket: params.get('storageBucket') || undefined,
      messagingSenderId,
      appId,
    });
  }
} catch (err) {
  console.warn('Failed to parse SW URL params:', err);
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'INIT_FIREBASE_CONFIG' && data.config) {
    initFirebaseInSW(data.config);
  }

  if (data.type === 'SHOW_NOTIFICATION' && data.payload) {
    const { title, body, tag, url, bookingId } = data.payload;
    event.waitUntil(
      self.registration.showNotification(title || 'إشعار جديد', {
        body: body || '',
        icon: '/app-icon.jpg',
        badge: '/app-icon.jpg',
        dir: 'rtl',
        lang: 'ar',
        tag: tag || `notif_${Date.now()}`,
        renotify: true,
        vibrate: [200, 100, 200],
        data: {
          url: url || '/',
          bookingId: bookingId || '',
        },
      })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
