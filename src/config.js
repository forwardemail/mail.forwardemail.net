export const config = {
  // Vite exposes VITE_* values plus the explicitly defined public VAPID key.
  // Use VITE_WEBMAIL_API_BASE=http://localhost:4000 for local development.
  apiBase: import.meta.env.VITE_WEBMAIL_API_BASE || 'https://api.forwardemail.net',
  // Must match the backend VAPID_PUBLIC_KEY used to encrypt UnifiedPush payloads.
  unifiedPushVapidPublicKey: import.meta.env.VAPID_PUBLIC_KEY || '',
};
