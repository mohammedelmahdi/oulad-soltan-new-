import { getMessaging, getToken, onMessage, isSupported, Messaging } from 'firebase/messaging';
import { doc, setDoc } from 'firebase/firestore';
import { app, db, auth, firebaseConfig, handleFirestoreError, OperationType } from './firebase';

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let messagingInstance: Messaging | null = null;
let unsubscribeOnMessage: (() => void) | null = null;

export type NotificationPermissionState = NotificationPermission | 'unsupported';

export function isBrowserNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotificationPermission(): NotificationPermissionState {
  if (!isBrowserNotificationSupported()) {
    return 'unsupported';
  }
  return Notification.permission;
}

export function isRunningInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function getStoredVapidKey(): string {
  try {
    return (
      localStorage.getItem('gac_vapid_key') ||
      import.meta.env.VITE_FIREBASE_VAPID_KEY ||
      ''
    ).trim();
  } catch {
    return '';
  }
}

export function playNotificationChime(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';

    osc1.frequency.setValueAtTime(587.33, now); // D5
    osc2.frequency.setValueAtTime(880, now + 0.08); // A5

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.14);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.36);

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 500);
  } catch {
    // Ignore audio context autoplay restrictions
  }
}

export async function registerNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  if (swRegistrationPromise) {
    return swRegistrationPromise;
  }

  swRegistrationPromise = (async () => {
    try {
      const params = new URLSearchParams({
        apiKey: firebaseConfig.apiKey || '',
        authDomain: firebaseConfig.authDomain || '',
        projectId: firebaseConfig.projectId || '',
        storageBucket: firebaseConfig.storageBucket || '',
        messagingSenderId: firebaseConfig.messagingSenderId || '',
        appId: firebaseConfig.appId || '',
      });

      const swUrl = `/firebase-messaging-sw.js?${params.toString()}`;
      const registration = await navigator.serviceWorker.register(swUrl, { scope: '/' });

      const activeWorker = registration.active || registration.waiting || registration.installing;
      if (activeWorker) {
        activeWorker.postMessage({
          type: 'INIT_FIREBASE_CONFIG',
          config: firebaseConfig,
        });
      }

      return registration;
    } catch (err) {
      console.warn('Service Worker registration failed:', err);
      swRegistrationPromise = null;
      return null;
    }
  })();

  return swRegistrationPromise;
}

export async function showBrowserNotification(options: {
  title: string;
  body: string;
  tag?: string;
  bookingId?: string;
  playSound?: boolean;
}): Promise<boolean> {
  if (!isBrowserNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }

  if (options.playSound !== false) {
    playNotificationChime();
  }

  const title = options.title || 'جمعية أولاد سلطان';
  const body = options.body || '';
  const tag = options.tag || `gac_notif_${Date.now()}`;

  try {
    // Prefer Service Worker showNotification (works on Android Chrome + Desktop Chrome)
    if ('serviceWorker' in navigator) {
      const registration = await registerNotificationServiceWorker();
      if (registration) {
        await registration.showNotification(title, {
          body,
          icon: '/app-icon.jpg',
          badge: '/app-icon.jpg',
          dir: 'rtl',
          lang: 'ar',
          tag,
          renotify: true,
          data: {
            url: window.location.origin + '/',
            bookingId: options.bookingId || '',
          },
        } as NotificationOptions);
        return true;
      }
    }
  } catch (err) {
    console.warn('SW showNotification failed, falling back to window.Notification:', err);
  }

  try {
    const notif = new Notification(title, {
      body,
      icon: '/app-icon.jpg',
      dir: 'rtl',
      lang: 'ar',
      tag,
    });
    notif.onclick = () => {
      window.focus();
      notif.close();
    };
    return true;
  } catch (err) {
    console.warn('Fallback Notification constructor failed:', err);
    return false;
  }
}

export async function initializeFcmForSession(params: {
  role: 'admin' | 'rider';
  riderId?: string;
  vapidKey?: string;
}): Promise<{ token: string | null; status: 'ready' | 'no_vapid' | 'unsupported' | 'denied' | 'error'; error?: string }> {
  if (!isBrowserNotificationSupported()) {
    return { token: null, status: 'unsupported' };
  }
  if (Notification.permission !== 'granted') {
    return { token: null, status: 'denied' };
  }

  try {
    const supported = await isSupported();
    if (!supported || !firebaseConfig.messagingSenderId) {
      return { token: null, status: 'unsupported' };
    }

    const registration = await registerNotificationServiceWorker();
    if (!messagingInstance) {
      messagingInstance = getMessaging(app);
    }

    // Listen to foreground FCM push messages
    if (!unsubscribeOnMessage && messagingInstance) {
      unsubscribeOnMessage = onMessage(messagingInstance, (payload) => {
        const title = payload.notification?.title || payload.data?.title || 'جمعية أولاد سلطان';
        const body = payload.notification?.body || payload.data?.body || '';
        showBrowserNotification({
          title,
          body,
          tag: payload.data?.tag || `fcm_fg_${Date.now()}`,
          bookingId: payload.data?.bookingId,
        });
      });
    }

    const resolvedVapidKey = (params.vapidKey || getStoredVapidKey()).trim();
    if (!resolvedVapidKey) {
      return { token: null, status: 'no_vapid' };
    }

    const token = await getToken(messagingInstance, {
      vapidKey: resolvedVapidKey,
      serviceWorkerRegistration: registration || undefined,
    });

    if (token) {
      const tokenId = token.slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '_');
      const tokenPath = `fcmTokens/${tokenId}`;
      try {
        await setDoc(doc(db, 'fcmTokens', tokenId), {
          id: tokenId,
          token,
          role: params.role,
          riderId: params.riderId || '',
          userEmail: auth.currentUser?.email || '',
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, tokenPath);
      }
      return { token, status: 'ready' };
    }

    return { token: null, status: 'error', error: 'لم يتم استلام رمز الجهاز من Google FCM' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('FCM initialization warning:', msg);
    return { token: null, status: 'error', error: msg };
  }
}

export async function requestGoogleNotificationPermission(params: {
  role: 'admin' | 'rider';
  riderId?: string;
  vapidKey?: string;
}): Promise<{
  permission: NotificationPermissionState;
  fcmToken: string | null;
  message: string;
}> {
  if (!isBrowserNotificationSupported()) {
    return {
      permission: 'unsupported',
      fcmToken: null,
      message: 'متصفحك الحالي لا يدعم إشعارات الويب.',
    };
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      await registerNotificationServiceWorker();
      const fcmResult = await initializeFcmForSession(params);

      await showBrowserNotification({
        title: 'تم تفعيل إشعارات Google بنجاح',
        body: 'ستصلك الآن إشعارات فورية على متصفح Google Chrome عند وجود أي حجوزات أو مهام جديدة.',
        tag: 'gac_permission_granted',
      });

      return {
        permission: 'granted',
        fcmToken: fcmResult.token,
        message: fcmResult.token
          ? 'تم تفعيل إشعارات Google وربط الجهاز بخدمة FCM بنجاح!'
          : 'تم تفعيل إشعارات Google Chrome الفورية بنجاح!',
      };
    }

    if (permission === 'denied') {
      return {
        permission: 'denied',
        fcmToken: null,
        message: isRunningInIframe()
          ? 'تم حظر الإشعارات داخل نافذة المعاينة. يرجى فتح التطبيق في نافذة متصفح مستقلة ثم السماح بالإشعارات.'
          : 'تم رفض إذن الإشعارات. يمكنك تفعيله من أيقونة القفل بجانب رابط الموقع في المتصفح.',
      };
    }

    return {
      permission,
      fcmToken: null,
      message: 'لم يتم اتخاذ قرار بشأن الإشعارات بعد.',
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      permission: getNotificationPermission(),
      fcmToken: null,
      message: `تعذر تفعيل الإشعارات: ${errMsg}`,
    };
  }
}
