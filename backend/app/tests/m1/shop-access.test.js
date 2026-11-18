import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import bcrypt from 'bcryptjs';
import { credentialVersion, isConfiguredShopAccount } from '../../src/utils/shopIdentity.js';
import { enforceShopAccess, managerMayAccess, maskManagerPayload, maskPhoneFields } from '../../src/utils/shopAccess.js';

test('only configured owner and manager accounts are eligible', () => {
  const old = process.env.ADMIN_USERNAME;
  process.env.ADMIN_USERNAME = 'owner-test';
  try {
    assert.equal(isConfiguredShopAccount({ role: 'ADMIN', username: 'owner-test' }), true);
    assert.equal(isConfiguredShopAccount({ role: 'ADMIN', username: 'another-admin' }), false);
    assert.equal(isConfiguredShopAccount({ role: 'MANAGER', username: 'manager@m77.demo' }), true);
    assert.equal(isConfiguredShopAccount({ role: 'STYLIST', username: 'stylist-test' }), false);
  } finally {
    if (old === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = old;
  }
});

test('changing a password invalidates the access-token credential version', async () => {
  const old = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-only-secret';
  try {
    const first = { password: await bcrypt.hash('first-test-password', 4) };
    const second = { password: await bcrypt.hash('second-test-password', 4) };
    assert.notEqual(credentialVersion(first), credentialVersion(second));
    assert.equal(credentialVersion(first), credentialVersion(first));
  } finally {
    if (old === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = old;
  }
});

test('manager route allowlist rejects sensitive operations', () => {
  for (const [method, path] of [
    ['GET', '/api/appointments?startDate=2026-11-19'],
    ['POST', '/api/members'],
    ['POST', '/api/transactions'],
    ['PATCH', '/api/appointments/example/status'],
  ]) assert.equal(managerMayAccess(method, path), true, `${method} ${path}`);
  for (const [method, path] of [
    ['GET', '/api/reports'],
    ['GET', '/api/sms-notifications'],
    ['PATCH', '/api/users/manager/password'],
    ['PUT', '/api/members/example'],
    ['POST', '/api/transactions/example/void'],
    ['POST', '/api/packages/holdings/example/refund'],
  ]) assert.equal(managerMayAccess(method, path), false, `${method} ${path}`);
});

test('manager responses mask nested phones while owner responses retain them', () => {
  const original = { phone: '13812345678', customerPhone: '13912345678', member: { phone: '13712345678' },
    rows: [{ memberPhone: '13612345678' }], amount: 99 };
  const masked = maskPhoneFields(original);
  assert.equal(masked.phone, '138****5678');
  assert.equal(masked.customerPhone, '139****5678');
  assert.equal(masked.member.phone, '137****5678');
  assert.equal(masked.rows[0].memberPhone, '136****5678');
  assert.equal(masked.amount, 99);
  assert.equal(original.phone, '13812345678');
  assert.equal(maskManagerPayload('ADMIN', JSON.stringify(original)), JSON.stringify(original));
  assert.equal(JSON.parse(maskManagerPayload('MANAGER', JSON.stringify(original))).phone, '138****5678');
});

test('Fastify private API requires login and rejects manager report access', async () => {
  const app = Fastify();
  app.addHook('onRequest', (request, reply) => enforceShopAccess(request, reply, async (req, res) => {
    const role = req.headers['x-test-role'];
    if (!role) { res.code(401).send({ message: 'login required' }); return false; }
    req.user = { role };
    return true;
  }));
  app.addHook('onSend', async (request, reply, payload) => maskManagerPayload(request.user?.role, payload));
  app.get('/api/members', async () => ({ data: [{ phone: '13812345678' }] }));
  app.get('/api/reports', async () => ({ total: 123 }));
  app.post('/api/transactions/tx/void', async () => ({ ok: true }));
  try {
    const anonymous = await app.inject({ url: '/api/members' });
    assert.equal(anonymous.statusCode, 401);
    const manager = await app.inject({ url: '/api/members', headers: { 'x-test-role': 'MANAGER' } });
    assert.equal(manager.statusCode, 200);
    assert.equal(manager.json().data[0].phone, '138****5678');
    const report = await app.inject({ url: '/api/reports', headers: { 'x-test-role': 'MANAGER' } });
    assert.equal(report.statusCode, 403);
    const voided = await app.inject({ method: 'POST', url: '/api/transactions/tx/void', headers: { 'x-test-role': 'MANAGER' } });
    assert.equal(voided.statusCode, 403);
    const owner = await app.inject({ url: '/api/members', headers: { 'x-test-role': 'ADMIN' } });
    assert.equal(owner.json().data[0].phone, '13812345678');
  } finally {
    await app.close();
  }
});
