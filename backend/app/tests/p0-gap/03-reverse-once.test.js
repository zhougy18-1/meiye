// 测试 3/9：重复撤销 —— 同一笔误扣只能撤销一次，第二次被拒，恢复次数只加一次，留痕原因与操作人
// 覆盖 AC-01/AC-02（履约撤销）、services/packages.js reverse() 条件 updateMany
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  prisma, createScope, createPackageService, PackageError, ROLES,
  post, tokenFor, DEMO,
} from './_helpers.js';

const scope = createScope('p03');
const adminToken = tokenFor('ADMIN');
const ACTOR = ROLES.ADMIN;
let memberId;
let service;

before(async () => {
  await scope.cleanup();
  service = createPackageService(prisma);
  const m = await prisma.member.create({ data: {
    id: scope.key('member'), phone: scope.qaPhone(), name: 'QA-重复撤销', status: 'ACTIVE',
  } });
  memberId = m.id;
});
after(async () => { await scope.cleanup(); await prisma.$disconnect(); });

async function makeHolding(totalUses = 3) {
  return prisma.packageHolding.create({ data: {
    memberId, planId: DEMO.planId, planName: 'QA 撤销套餐',
    totalUses, remainingUses: totalUses, paidAmount: '99.00',
    paymentMethod: 'CASH', status: 'ACTIVE', purchasedAt: new Date(),
    createdBy: ACTOR.id, createdByName: ACTOR.username,
    requestKey: scope.key('holding'),
  } });
}
async function makeUsage(holdingId) {
  const result = await service.redeem(holdingId, { requestKey: scope.key('usage'), note: 'QA 待撤销' }, ACTOR);
  return result.usage.id;
}

describe('AC-01/AC-02 误扣撤销只生效一次', () => {
  test('连续两次撤销：第一次成功，第二次 409；恢复次数只 +1；原因与操作人留痕', async () => {
    const holding = await makeHolding(3);
    const usageId = await makeUsage(holding.id);
    assert.equal((await prisma.packageHolding.findUnique({ where: { id: holding.id } })).remainingUses, 2);

    const reason = 'QA 误扣撤销-连续';
    const first = await service.reverse(usageId, reason, ACTOR);
    assert.equal(first.holding.remainingUses, 3, '撤销应恢复一次次数');
    assert.ok(first.usage.reversedAt instanceof Date);

    await assert.rejects(
      () => service.reverse(usageId, reason, ACTOR),
      (e) => e instanceof PackageError && e.statusCode === 409 && /已经撤销/.test(e.message),
    );

    const h = await prisma.packageHolding.findUnique({ where: { id: holding.id } });
    assert.equal(h.remainingUses, 3, '重复撤销不得再次增加次数');
    const u = await prisma.packageUsage.findUnique({ where: { id: usageId } });
    assert.ok(u.reversedAt instanceof Date, 'reversedAt 必须落库');
    assert.equal(u.reverseReason, reason, '撤销原因必须留痕');
    assert.equal(u.reversedBy, ACTOR.id, '操作人 ID 必须留痕');
    assert.equal(u.reversedByName, ACTOR.username, '操作人姓名必须留痕');
    assert.equal(await prisma.packageUsage.count({ where: { holdingId: holding.id, reversedAt: null } }), 0);
  });

  test('HTTP 链路重复撤销：第二次 409，且次数不重复恢复', async () => {
    const holding = await makeHolding(2);
    const usageId = await makeUsage(holding.id);
    const body = { reason: 'QA 误扣撤销-HTTP' };
    const r1 = await post(`/api/packages/usages/${usageId}/reverse`, { token: adminToken, body });
    const r2 = await post(`/api/packages/usages/${usageId}/reverse`, { token: adminToken, body });
    assert.equal(r1.status, 200, `首次撤销应成功: ${r1.status} ${r1.text}`);
    assert.equal(r2.status, 409, `重复撤销应 409: ${r2.status} ${r2.text}`);
    assert.equal((await prisma.packageHolding.findUnique({ where: { id: holding.id } })).remainingUses, 2);
    assert.ok((await prisma.packageUsage.findUnique({ where: { id: usageId } })).reversedAt);
  });

  test('并发 6 次撤销同一笔误扣：恰好 1 成功、5 个 409，次数只恢复一次', async () => {
    const holding = await makeHolding(3);
    const usageId = await makeUsage(holding.id);
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => service.reverse(usageId, 'QA 并发撤销', ACTOR)),
    );
    const ok = settled.filter(s => s.status === 'fulfilled');
    const bad = settled.filter(s => s.status === 'rejected');
    assert.equal(ok.length, 1, `应恰好 1 次成功，实际 ${ok.length}`);
    assert.equal(bad.length, 5);
    for (const r of bad) assert.equal(r.reason?.statusCode, 409);
    assert.equal((await prisma.packageHolding.findUnique({ where: { id: holding.id } })).remainingUses, 3);
  });

  test('权限双层：STYLIST/ASSISTANT 撤销 403、未认证 401，且不得改变数据', async () => {
    const holding = await makeHolding(2);
    const usageId = await makeUsage(holding.id);
    for (const role of ['STYLIST', 'ASSISTANT']) {
      const r = await post(`/api/packages/usages/${usageId}/reverse`, {
        token: tokenFor(role), body: { reason: 'QA 越权撤销' },
      });
      assert.equal(r.status, 403, `${role} 应 403: ${r.status} ${r.text}`);
    }
    const noAuth = await post(`/api/packages/usages/${usageId}/reverse`, { body: { reason: 'QA 未认证' } });
    assert.equal(noAuth.status, 401);
    const u = await prisma.packageUsage.findUnique({ where: { id: usageId } });
    assert.equal(u.reversedAt, null, '越权请求不得触发撤销');
    assert.equal((await prisma.packageHolding.findUnique({ where: { id: holding.id } })).remainingUses, 1);
  });

  test('边界：空原因 400、不存在扣次记录 404', async () => {
    const holding = await makeHolding(2);
    const usageId = await makeUsage(holding.id);
    const empty = await post(`/api/packages/usages/${usageId}/reverse`, {
      token: adminToken, body: { reason: '   ' },
    });
    assert.equal(empty.status, 400, `纯空白原因应 400: ${empty.status} ${empty.text}`);
    const missing = await post('/api/packages/usages/qa-no-such-usage/reverse', {
      token: adminToken, body: { reason: 'QA 不存在' },
    });
    assert.equal(missing.status, 404, `不存在记录应 404: ${missing.status} ${missing.text}`);
    assert.equal((await prisma.packageHolding.findUnique({ where: { id: holding.id } })).remainingUses, 1);
  });
});
