// 测试 2/9：并发扣次 —— 不得超扣、不得为负；reversedAt=null 的 PackageUsage 条数 == 成功次数
// 覆盖 AC-01/AC-02（履约台账）、services/packages.js redeem() 条件 updateMany + atomic()
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  prisma, createScope, createPackageService, ROLES,
  post, tokenFor, DEMO,
} from './_helpers.js';

const scope = createScope('p02');
const adminToken = tokenFor('ADMIN');
const ACTOR = ROLES.ADMIN;
let memberId;

before(async () => {
  await scope.cleanup();
  const m = await prisma.member.create({ data: {
    id: scope.key('member'), phone: scope.qaPhone(), name: 'QA-并发扣次', status: 'ACTIVE',
  } });
  memberId = m.id;
});
after(async () => { await scope.cleanup(); await prisma.$disconnect(); });

async function makeHolding(totalUses) {
  return prisma.packageHolding.create({ data: {
    memberId, planId: DEMO.planId, planName: 'QA 并发扣次套餐',
    totalUses, remainingUses: totalUses, paidAmount: '99.00',
    paymentMethod: 'CASH', status: 'ACTIVE', purchasedAt: new Date(),
    createdBy: ACTOR.id, createdByName: ACTOR.username,
    requestKey: scope.key('holding'),
  } });
}

async function assertLedger(holdingId, expectedSuccesses, totalUses) {
  const holding = await prisma.packageHolding.findUnique({ where: { id: holdingId } });
  assert.ok(holding, '次卡必须存在');
  assert.equal(holding.remainingUses, totalUses - expectedSuccesses, '剩余次数必须等于总次数减成功次数');
  assert.ok(holding.remainingUses >= 0, '剩余次数不得为负');
  const usages = await prisma.packageUsage.findMany({ where: { holdingId, reversedAt: null } });
  assert.equal(usages.length, expectedSuccesses,
    'reversedAt=null 的 PackageUsage 条数必须与成功次数一致');
  assert.equal(new Set(usages.map(u => u.requestKey)).size, expectedSuccesses,
    '每次成功扣次应有独立的 requestKey');
  return holding;
}

describe('AC-01/AC-02 并发扣次不超扣', () => {
  test('HTTP 并发 8 次扣次（剩余 5 次）：恰好 5 成功 3 失败，余额归零不为负', async () => {
    const holding = await makeHolding(5);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post(
        `/api/packages/holdings/${holding.id}/redeem`,
        { token: adminToken, body: { requestKey: scope.key('redeem'), note: 'QA 并发扣次' } },
      )),
    );
    const ok = results.filter(r => r.status === 200);
    const failed = results.filter(r => r.status !== 200);
    assert.equal(ok.length, 5, `应有 5 次成功，实际 ${ok.length}；状态: ${results.map(r => r.status).join(',')}`);
    assert.equal(failed.length, 3);
    for (const r of failed) assert.equal(r.status, 409, `超扣应返回 409: ${r.status} ${r.text}`);
    await assertLedger(holding.id, 5, 5);
  });

  test('服务层并发 8 次扣次（剩余 3 次）：恰好 3 成功，Promise.allSettled 中其余为业务错误', async () => {
    const service = createPackageService(prisma);
    const holding = await makeHolding(3);
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.redeem(
        holding.id, { requestKey: scope.key('svc-redeem'), note: 'QA' }, ACTOR,
      )),
    );
    const fulfilled = settled.filter(s => s.status === 'fulfilled');
    const rejected = settled.filter(s => s.status === 'rejected');
    assert.equal(fulfilled.length, 3,
      `应有 3 次成功，实际 ${fulfilled.length}；失败原因: ${rejected.map(r => String(r.reason?.message)).join(' | ')}`);
    assert.equal(rejected.length, 5);
    for (const r of rejected) {
      assert.equal(r.reason?.statusCode, 409, `超扣应为业务 409: ${String(r.reason)}`);
    }
    await assertLedger(holding.id, 3, 3);
  });

  test('同一 requestKey 重复扣次：只扣一次、只生成一条 usage', async () => {
    const service = createPackageService(prisma);
    const holding = await makeHolding(3);
    const requestKey = scope.key('dup-redeem');
    const a = await service.redeem(holding.id, { requestKey }, ACTOR);
    const b = await service.redeem(holding.id, { requestKey }, ACTOR);
    assert.equal(b.usage.id, a.usage.id, '重复 requestKey 必须返回同一条扣次记录');
    await assertLedger(holding.id, 1, 3);
  });

  test('边界：PAUSED / REFUNDED / VOID 状态不可扣次（409）', async () => {
    const service = createPackageService(prisma);
    for (const status of ['PAUSED', 'REFUNDED', 'VOID']) {
      const holding = await makeHolding(3);
      await prisma.packageHolding.update({ where: { id: holding.id }, data: { status } });
      await assert.rejects(
        () => service.redeem(holding.id, { requestKey: scope.key('blocked') }, ACTOR),
        (e) => e.statusCode === 409,
        `${status} 状态应拒绝扣次`,
      );
      const after = await prisma.packageHolding.findUnique({ where: { id: holding.id } });
      assert.equal(after.remainingUses, 3, `${status} 状态不得扣减次数`);
      assert.equal(await prisma.packageUsage.count({ where: { holdingId: holding.id } }), 0);
    }
  });

  test('边界：已过期次卡不可扣次（409），且次数不变', async () => {
    const service = createPackageService(prisma);
    const holding = await makeHolding(2);
    await prisma.packageHolding.update({
      where: { id: holding.id },
      data: { expiresAt: new Date(Date.now() - 86400000) },
    });
    await assert.rejects(
      () => service.redeem(holding.id, { requestKey: scope.key('expired') }, ACTOR),
      (e) => e.statusCode === 409 && /过期/.test(e.message),
    );
    const after = await prisma.packageHolding.findUnique({ where: { id: holding.id } });
    assert.equal(after.remainingUses, 2);
  });
});
