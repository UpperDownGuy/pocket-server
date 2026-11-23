import { connect } from 'node:http2';
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';

// Keep existing development deployments on the sandbox unless explicitly set.
// TestFlight and App Store builds require production. Keys stay on the server.
export function createAPNsProvider(env = process.env, { connectHTTP2 = connect, readKey = readFileSync } = {}) {
  const environment = env.APNS_ENVIRONMENT ?? 'sandbox';
  if (!['sandbox', 'production'].includes(environment)) throw new Error('APNS_ENVIRONMENT must be sandbox or production.');
  const values = [env.APNS_TEAM_ID, env.APNS_KEY_ID, env.APNS_TOPIC, env.APNS_KEY_PATH];
  if (values.every(value => !value)) return null;
  if (values.some(value => !value)) throw new Error('Set all four APNS_* values, or remove them all.');
  const key = createPrivateKey(readKey(env.APNS_KEY_PATH));
  const endpoint = environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  let cachedToken;
  let tokenTime = 0;
  function token() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && now - tokenTime < 3000) return cachedToken;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })).toString('base64url');
    const input = `${header}.${claims}`;
    const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
    cachedToken = `${input}.${signature.toString('base64url')}`;
    tokenTime = now;
    return cachedToken;
  }
  return {
    environment,
    async send(deviceToken, notification) {
      // Accept only the server-owned inbox fields; never forward an arbitrary
      // object supplied with device registration or a transaction request.
      const { title, body, notificationId, transactionId, recipientId, kind } = notification ?? {};
      if (![title, body, notificationId, transactionId, recipientId].every(value => typeof value === 'string') ||
          !title || !notificationId || Buffer.byteLength(notificationId) > 64 || !transactionId || !recipientId || !['addition', 'purchase'].includes(kind)) {
        return { ok: false, retry: false, reason: 'Invalid notification payload' };
      }
      // Expo SDK 58's iOS remote serializer reads content.data from userInfo.body.
      // This custom dictionary is separate from the displayed aps.alert.body.
      const payload = JSON.stringify({ aps: { alert: { title, body }, sound: 'default' },
        body: { type: 'balance', kind, notificationId, transactionId, recipientId } });
      if (Buffer.byteLength(payload) > 4096) return { ok: false, retry: false, reason: 'Notification payload is too large' };
      return await new Promise((resolve, reject) => {
        const client = connectHTTP2(endpoint);
        let done = false;
        const finish = (error, value) => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          client.destroy();
          error ? reject(error) : resolve(value);
        };
        const timeout = setTimeout(() => finish(new Error('APNs timeout')), 10000);
        client.on('error', error => finish(error));
        const request = client.request({
          ':method': 'POST', ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${token()}`,
          'apns-topic': env.APNS_TOPIC, 'apns-push-type': 'alert',
          // Retrying the same durable inbox event must replace that alert,
          // while distinct balance changes keep distinct notifications.
          'apns-collapse-id': notificationId,
          // Ask APNs not to retain alerts for offline devices: a later account
          // switch cannot recall them. The inbox preserves missed activity.
          'apns-priority': '10', 'apns-expiration': '0',
          'content-type': 'application/json',
        });
        let status = 0;
        let body = '';
        request.on('response', headers => { status = Number(headers[':status']); });
        request.on('data', chunk => { if (body.length < 4096) body += chunk.toString(); });
        request.on('error', error => finish(error));
        request.on('end', () => {
          let reason = '';
          try { reason = JSON.parse(body).reason ?? ''; } catch { /* Success has no body. */ }
          finish(null, { ok: status === 200, retry: status === 429 || status >= 500,
            invalidToken: status === 410 || reason === 'BadDeviceToken', reason: reason || `HTTP ${status}` });
        });
        request.end(payload);
      });
    },
  };
}
