// 测试 1/9：重复购买 —— 同一 requestKey 只产生一笔 PackageHolding，金额与次数不重复
// 覆盖 AC-01 / AC-02（幂等购买）、架构 §3.1 与 services/packages.js purchase()
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  prisma, createScope, createPackageService, PackageError, ROLES,
  post, tokenFor, DEMO, dec,
} from './_helpers.js';

const scope = createScope('p01');
const adminToken = tokenFor('ADMIN');
const ACTOR = ROLES.ADMIN;
let memberId;

before(async () => {
  await scope.cleanup();
  const m = await prisma.member.create({ data: {
    id: scope.key('member'), phone: scope.qaPhone(), name: 'QA-重复购买', status: 'ACTIVE',
  } });
  memberId = m.id;
});
after(async () => { await scope.cleanup(); await prisma.$disconnect(); });

const payload = (requestKey, paidAmount = '99.00') => ({
  memberId, planId: DEMO.planId, paidAmount, paymentMethod: 'CASH', requestKey,
});

describe('AC-01/AC-02 套餐购买 requestKey 幂等', () => {
  test('同一 requestKey 连续提交两次：只产生一笔，金额/次数不重复，快照字段完整', async () => {
    const requestKey = scope.key('seq-purchase');
    const r1 = await post('/api/packages/holdings', { token: adminToken, body: payload(requestKey) });
    const r2 = await post('/api/packages/holdings', { token: adminToken, body: payload(requestKey) });

    assert.equal(r1.status, 200, `首次购买应成功: ${r1.status} ${r1.text}`);
    assert.equal(r2.status, 200, `重复购买应幂等返回 200: ${r2.status} ${r2.text}`);
    assert.equal(r2.json.id, r1.json.id, '两次必须返回同一张次卡');

    const rows = await prisma.packageHolding.findMany({ where: { requestKey } });
    assert.equal(rows.length, 1, 'DB 中只能有一笔 PackageHolding');
    const h = rows[0];
    assert.equal(dec(h.paidAmount).toFixed(2), '99.00', '实收金额不得重复累加');
    assert.equal(h.totalUses, 3);
    assert.equal(h.remainingUses, 3, '剩余次数不得被重复扣减');
    assert.equal(h.status, 'ACTIVE');
    assert.equal(h.paymentMethod, 'CASH');
    assert.equal(h.planName, '99元大白肌3次体验', '购买快照应保留');
    assert.equal(h.createdBy, ACTOR.id);
    assert.equal(h.createdByName, ACTOR.username);
    assert.ok(h.purchasedAt instanceof Date);
    assert.equal(await prisma.transaction.count({ where: { memberId } }), 0,
      '购买不得写入旧 Transaction（独立台账原则）');
  });

  test('HTTP 并发 10 次同一 requestKey：仍只有一笔（走真实 Fastify + 数据库唯一约束）', async () => {
    const requestKey = scope.key('http-concurrent-purchase');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post('/api/packages/holdings', {
        token: adminToken, body: payload(requestKey),
      })),
    );
    for (const r of results) {
      assert.equal(r.status, 200, `并发购买不应报错: ${r.status} ${r.text}`);
    }
    const ids = new Set(results.map(r => r.json.id));
    assert.equal(ids.size, 1, '并发请求必须收敛到同一张次卡');
    const rows = await prisma.packageHolding.findMany({ where: { requestKey } });
    assert.equal(rows.length, 1, '并发下不得产生多笔 PackageHolding');
    assert.equal(dec(rows[0].paidAmount).toFixed(2), '99.00');
    assert.equal(rows[0].remainingUses, 3);
  });

  test('服务层并发 10 次同一 requestKey：atomic() + P2002 回退收敛为一笔', async () => {
    const service = createPackageService(prisma);
    const requestKey = scope.key('svc-concurrent-purchase');
    const body = payload(requestKey);
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.purchase(body, ACTOR)),
    );
    const rejected = settled.filter(s => s.status === 'rejected');
    assert.equal(rejected.length, 0,
      `并发购买不应抛异常: ${rejected.map(r => String(r.reason?.message)).join(' | ')}`);
    const ids = new Set(settled.map(s => s.value.id));
    assert.equal(ids.size, 1);
    assert.equal(await prisma.packageHolding.count({ where: { requestKey } }), 1);
  });

  test('同一 requestKey 换参数重放：409 拒绝，且不产生第二笔、不改原金额', async () => {
    const requestKey = scope.key('replay-mismatch');
    const ok = await post('/api/packages/holdings', { token: adminToken, body: payload(requestKey, '99.00') });
    assert.equal(ok.status, 200);
    const tampered = await post('/api/packages/holdings', {
      token: adminToken, body: payload(requestKey, '88.00'),
    });
    assert.equal(tampered.status, 409, `参数不一致的重放应被拒: ${tampered.status} ${tampered.text}`);
    assert.match(tampered.text, /请求编号已用于另一笔购买/);
    const rows = await prisma.packageHolding.findMany({ where: { requestKey } });
    assert.equal(rows.length, 1);
    assert.equal(dec(rows[0].paidAmount).toFixed(2), '99.00', '原实收金额不得被篡改');
  });

  test('边界：实收金额 0 被拒 400，且不落库', async () => {
    const requestKey = scope.key('zero-amount');
    const r = await post('/api/packages/holdings', { token: adminToken, body: payload(requestKey, '0') });
    assert.equal(r.status, 400, `实收金额必须大于 0: ${r.status} ${r.text}`);
    assert.equal(await prisma.packageHolding.count({ where: { requestKey } }), 0);
  });

  test('边界：服务层不存在会员 / 不存在套餐均被拒 400', async () => {
    const service = createPackageService(prisma);
    await assert.rejects(
      () => service.purchase({ ...payload(scope.key('bad-member')), memberId: 'qa-no-such-member' }, ACTOR),
      (e) => e instanceof PackageError && e.statusCode === 400,
    );
    await assert.rejects(
      () => service.purchase({ ...payload(scope.key('bad-plan')), planId: 'qa-no-such-plan' }, ACTOR),
      (e) => e instanceof PackageError && e.statusCode === 400,
    );
  });
});
