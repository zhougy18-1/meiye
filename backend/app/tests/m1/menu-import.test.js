import test from 'node:test';
import assert from 'node:assert/strict';
import { MENU, planImport, importMenu } from '../../scripts/import-m77-menu.js';

test('12 项资费、次数和长期有效映射正确', () => {
  const rows = planImport([], []);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.map((row) => [row.price, row.uses]), [
    ['99.00', 3], ['108.00', 1], ['128.00', 1], ['980.00', 1],
    ['368.00', 3], ['108.00', 1], ['3980.00', 1], ['1980.00', 1],
    ['4980.00', 1], ['596.00', 3], ['199.00', 1], ['298.00', 3],
  ]);
  assert.equal(new Set(MENU.map((row) => row.name)).size, 12);
});

test('已有完全一致的服务和套餐被复用，不重复创建', () => {
  const first = planImport([], [])[0];
  const rows = planImport([
    { id: first.serviceId, name: first.name, standardPrice: first.price, status: 'AVAILABLE' },
  ], [
    { id: first.planId, name: first.name, serviceId: first.serviceId, price: first.price,
      totalUses: first.uses, validDays: null, active: true },
  ]);
  assert.equal(rows[0].serviceAction, 'reuse');
  assert.equal(rows[0].planAction, 'reuse');
  assert.equal(rows.filter((row) => row.planAction === 'create').length, 11);
});

test('冲突价格、次数和 ID 均阻止导入', () => {
  const first = planImport([], [])[0];
  assert.throws(() => planImport([
    { id: first.serviceId, name: first.name, standardPrice: '100.00', status: 'AVAILABLE' },
  ], []), /服务项目冲突/);
  assert.throws(() => planImport([], [
    { id: first.planId, name: first.name, serviceId: first.serviceId,
      price: first.price, totalUses: 1, validDays: null, active: true },
  ]), /套餐冲突/);
  assert.throws(() => planImport([
    { id: 'other', name: first.name, standardPrice: first.price, status: 'AVAILABLE' },
    { id: first.serviceId, name: '别的项目', standardPrice: first.price, status: 'AVAILABLE' },
  ], []), /ID 与名称/);
});

test('预演不写入；正式导入一次创建 12 项', async () => {
  const saved = { services: [], plans: [] };
  const db = {
    user: { findUnique: async () => ({ id: 'owner', role: 'ADMIN' }) },
    service: { findMany: async () => saved.services, create: async ({ data }) => saved.services.push(data) },
    packagePlan: { findMany: async () => saved.plans, create: async ({ data }) => saved.plans.push(data) },
    $transaction: async (callback) => callback(db),
  };
  const previous = process.env.ADMIN_USERNAME;
  process.env.ADMIN_USERNAME = 'owner';
  try {
    await importMenu(db, false);
    assert.equal(saved.services.length, 0);
    assert.equal(saved.plans.length, 0);
    await importMenu(db, true);
    assert.equal(saved.services.length, 12);
    assert.equal(saved.plans.length, 12);
    assert.ok(saved.plans.every((plan) => plan.validDays === null && plan.createdBy === 'owner'));
    const again = await importMenu(db, true);
    assert.ok(again.every((row) => row.serviceAction === 'reuse' && row.planAction === 'reuse'));
    assert.equal(saved.plans.length, 12);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previous;
  }
});
