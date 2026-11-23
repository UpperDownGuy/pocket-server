import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createAPNsProvider } from '../apns.mjs';

// Synthetic test key only: no Apple account, filesystem key or network access.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const testKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { APNS_TEAM_ID: 'TESTTEAM01', APNS_KEY_ID: 'TESTKEY001', APNS_TOPIC: 'com.example.pocket.test', APNS_KEY_PATH: 'unused-test-key.p8' };
const notification = { title: 'Avery: $5.00 added', body: 'Allowance', kind: 'addition',
  notificationId: '752517fd-b8ed-410f-83e1-f24007e28afb', transactionId: 'ecb68603-5f11-4c46-a047-e131f2a20f22', recipientId: '453e5950-de42-499b-8616-15ec12c16e12' };
const deviceToken = 'a'.repeat(64);

function fixture({ environment, status = 200, reason, error } = {}) {
  const requests = [];
  let destroyed = 0;
  const provider = createAPNsProvider({ ...env, ...(environment === undefined ? {} : { APNS_ENVIRONMENT: environment }) }, {
    readKey: () => testKey,
    connectHTTP2(endpoint) {
      const client = new EventEmitter();
      client.destroy = () => { destroyed++; };
      client.request = headers => {
        const request = new EventEmitter();
        request.end = body => {
          requests.push({ endpoint, headers, body });
          queueMicrotask(() => {
            if (error) { request.emit('error', new Error('Synthetic connection failure')); return; }
            request.emit('response', { ':status': status });
            if (reason) request.emit('data', Buffer.from(JSON.stringify({ reason })));
            request.emit('end');
          });
        };
        return request;
      };
      return client;
    },
  });
  return { provider, requests, get destroyed() { return destroyed; } };
}

test('production APNs sends a bounded detailed alert with recipient-scoped tap metadata', async () => {
  const f = fixture({ environment: 'production' });
  assert.equal(f.provider.environment, 'production');
  assert.equal((await f.provider.send(deviceToken, { ...notification, ignored: 'must not be forwarded' })).ok, true);
  const request = f.requests[0];
  assert.equal(request.endpoint, 'https://api.push.apple.com');
  assert.equal(request.headers[':method'], 'POST');
  assert.equal(request.headers[':path'], `/3/device/${deviceToken}`);
  assert.equal(request.headers['apns-topic'], env.APNS_TOPIC);
  assert.equal(request.headers['apns-push-type'], 'alert');
  assert.equal(request.headers['apns-collapse-id'], notification.notificationId);
  assert.equal(request.headers['apns-priority'], '10');
  assert.equal(request.headers['apns-expiration'], '0');
  assert.deepEqual(JSON.parse(request.body), { aps: { alert: { title: notification.title, body: notification.body }, sound: 'default' },
    body: { type: 'balance', kind: 'addition', notificationId: notification.notificationId, transactionId: notification.transactionId, recipientId: notification.recipientId } });
  assert.ok(Buffer.byteLength(request.body) <= 4096);
  const parts = request.headers.authorization.replace(/^bearer /, '').split('.');
  assert.equal(JSON.parse(Buffer.from(parts[0], 'base64url')).alg, 'ES256');
  assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url')).iss, env.APNS_TEAM_ID);
  assert.ok(verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')));
  assert.equal(f.destroyed, 1);
});

test('Expo SDK 58 remote serialization exposes routing metadata in notification.content.data', async () => {
  const f = fixture({ environment: 'production' });
  await f.provider.send(deviceToken, { ...notification, kind: 'purchase', title: 'Avery: $5.00 spent', body: 'Bookshop' });
  const userInfo = JSON.parse(f.requests[0].body);
  // NotificationRecords.swift serializedNotificationData for UNPushNotificationTrigger
  // returns userInfo["body"] as a dictionary, not other top-level custom keys.
  const data = userInfo.body && typeof userInfo.body === 'object' && !Array.isArray(userInfo.body) ? userInfo.body : null;
  assert.deepEqual(data, { type: 'balance', kind: 'purchase', notificationId: notification.notificationId,
    transactionId: notification.transactionId, recipientId: notification.recipientId });
  assert.equal(userInfo.aps.alert.body, 'Bookshop');
  assert.equal(typeof userInfo.aps.alert.body, 'string');
});

test('sandbox remains the default and retries reuse the notification collapse identifier', async () => {
  const f = fixture();
  await f.provider.send(deviceToken, notification);
  await f.provider.send(deviceToken, notification);
  assert.equal(f.provider.environment, 'sandbox');
  assert.equal(f.requests[0].endpoint, 'https://api.sandbox.push.apple.com');
  assert.equal(f.requests[0].headers['apns-collapse-id'], f.requests[1].headers['apns-collapse-id']);
  assert.equal(f.requests[0].headers.authorization, f.requests[1].headers.authorization);
});

test('invalid environment and incomplete APNs configuration fail before connecting', () => {
  assert.equal(createAPNsProvider({}), null);
  assert.equal(createAPNsProvider({ APNS_ENVIRONMENT: 'production' }), null);
  for (const environment of ['', 'Production', 'invalid']) {
    assert.throws(() => createAPNsProvider({ ...env, APNS_ENVIRONMENT: environment }), /APNS_ENVIRONMENT/);
  }
  assert.throws(() => createAPNsProvider({ APNS_TEAM_ID: env.APNS_TEAM_ID }), /all four/);
});

test('malformed or oversized notification metadata is rejected without network calls', async () => {
  const f = fixture({ environment: 'production' });
  for (const value of [undefined, {}, { ...notification, recipientId: '' }, { ...notification, transactionId: 12 }, { ...notification, kind: 'other' },
    { ...notification, notificationId: 'a'.repeat(65) }, { ...notification, body: '💸'.repeat(1100) }]) {
    const result = await f.provider.send(deviceToken, value);
    assert.equal(result.ok, false);
    assert.equal(result.retry, false);
  }
  assert.equal(f.requests.length, 0);
});

test('APNs failures retain retry and expired-token classification and close connections', async () => {
  for (const [status, reason, retry, invalidToken] of [[429, 'TooManyRequests', true, false], [503, 'ServiceUnavailable', true, false],
    [410, 'Unregistered', false, true], [400, 'BadDeviceToken', false, true], [403, 'InvalidProviderToken', false, false]]) {
    const f = fixture({ status, reason });
    assert.deepEqual(await f.provider.send(deviceToken, notification), { ok: false, retry, invalidToken, reason });
    assert.equal(f.destroyed, 1);
  }
  const f = fixture({ error: true });
  await assert.rejects(f.provider.send(deviceToken, notification), /Synthetic connection failure/);
  assert.equal(f.destroyed, 1);
});
