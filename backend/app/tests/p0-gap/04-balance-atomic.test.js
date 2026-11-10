// 测试 4/9：余额扣减 —— 并发扣减不得出现负余额；撤销后余额前后快照字段齐备
// 覆盖 AC-09/AC-10（收银并发/幂等）、utils/balance.js、routes/transactions.js void
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  prisma, createScope, atomicDecrementBalance, Decimal, DEMO,
  post, patch, tokenFor, snapshotConfig, restoreConfig, dec,
} from './_helpers.js';

const scope = createScope('p04');
const adminToken = tokenFor('ADMIN');
let memberId;
let qaServiceId;

before(async () => {
  await scope.cleanup();
  const m = await prisma.member.create({ data: {
    id: scope.key('member'), phone: scope.qaPhone(), name: 'QA-余额扣减',
    status: 'ACTIVE', smsNotificationEnabled: false, // 避免生成 SmsNotification（void 删交易受外键约束）
  } });
  memberId = m.id;
  const svc = await prisma.service.create({ data: {
    id: scope.key('svc'), name: scope.key('svcname'), standardPrice: '10.00',
    status: 'AVAILABLE', sortOrder: 999, noDiscount: false,
  } });
  qaServiceId = svc.id;
});
after(async () => { await scope.cleanup(); await prisma.$disconnect(); });

async function makeCard(balance) {
  return prisma.card.create({ data: {
    id: scope.key('card'), memberId, cardTypeId: DEMO.cardTypeId,
    balance, status: 'ACTIVE', isCustomCard: false, discountSource: 'card_type',
  } });
}

const txBody = (cardId, tag) => ({
  memberId, customerName: scope.key('tx'), cardId,
  serviceIds: [qaServiceId], paymentMethod: 'MEMBER_CARD',
  notes: `qa-p04-${tag}`,
});

const cardBalance = async (id) => dec((await prisma.card.findUnique({ where: { id } })).balance);

describe('AC-09/AC-10 会员卡余额并发扣减', () => {
  test('HTTP 并发 12 笔各扣 10 元（余额 100）：恰好 10 成功 2 失败，余额归零且不为负', async () => {
    const card = await makeCard('100.00');
    const results = await Promise.all(
      Array.from({ length: 12 }, () => post('/api/transactions', {
        token: adminToken, body: txBody(card.id, 'concurrent'),
      })),
    );
    const ok = results.filter(r => r.status === 200);
    const failed = results.filter(r => r.status !== 200);
    assert.equal(ok.length, 10,
      `应 10 成功，实际 ${ok.length}；状态: ${results.map(r => r.status).join(',')}`);
    assert.equal(failed.length, 2);
    for (const r of failed) assert.equal(r.status, 400, `余额不足应 400: ${r.status} ${r.text}`);
    const final = await cardBalance(card.id);
    assert.equal(final.toFixed(2), '0.00');
    assert.ok(final.greaterThanOrEqualTo(0), '余额不得为负');
    assert.equal(await prisma.transaction.count({ where: { memberId } }), 10,
      '成功交易数必须与成功次数一致，失败不得落库');
  });

  test('服务层 atomicDecrementBalance 并发 8 次各扣 10（余额 30）：3 成功 5 INSUFFICIENT_BALANCE', async () => {
    const card = await makeCard('30.00');
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => atomicDecrementBalance(prisma, card.id, 10)),
    );
    const ok = settled.filter(s => s.status === 'fulfilled');
    const bad = settled.filter(s => s.status === 'rejected');
    assert.equal(ok.length, 3, `应 3 成功，实际 ${ok.length}`);
    assert.equal(bad.length, 5);
    for (const r of bad) assert.equal(r.reason?.message, 'INSUFFICIENT_BALANCE');
    assert.equal((await cardBalance(card.id)).toFixed(2), '0.00');
  });

  test('单笔交易余额前后快照字段齐备（totalBalanceBefore/After + cards[].balanceBefore/After/isUsed）', async () => {
    const card = await makeCard('50.00');
    const r = await post('/api/transactions', { token: adminToken, body: txBody(card.id, 'snapshot') });
    assert.equal(r.status, 200, `交易应成功: ${r.status} ${r.text}`);
    const tx = await prisma.transaction.findUnique({ where: { id: r.json.id } });
    const snap = tx.balanceSnapshot;
    assert.ok(snap && typeof snap === 'object', 'balanceSnapshot 必须落库');
    // 注意：getMemberBalanceSnapshot 返回的是「该会员所有有效卡」的合计，
    // 不是单卡余额；因此这里断言前后差额，单卡的绝对值在下面单独断言。
    assert.equal(typeof snap.totalBalanceBefore, 'number');
    assert.equal(typeof snap.totalBalanceAfter, 'number');
    assert.equal(dec(snap.totalBalanceBefore).minus(snap.totalBalanceAfter).toFixed(2), '10.00',
      '交易前后总余额差额必须等于本笔扣减金额');
    assert.ok(Array.isArray(snap.cards) && snap.cards.length >= 1);
    const used = snap.cards.find(c => c.cardId === card.id);
    assert.ok(used, '快照必须包含被扣减的卡');
    assert.equal(dec(used.balanceBefore).toFixed(2), '50.00');
    assert.equal(dec(used.balanceAfter).toFixed(2), '40.00');
    assert.equal(used.isUsed, true);
    assert.equal(typeof used.cardName, 'string');
    assert.equal((await cardBalance(card.id)).toFixed(2), '40.00');
  });

  test('撤销交易后余额恢复 + VoidLog 保留完整余额前后快照（ADMIN）', async () => {
    const card = await makeCard('50.00');
    const created = await post('/api/transactions', { token: adminToken, body: txBody(card.id, 'void') });
    assert.equal(created.status, 200);
    const txId = created.json.id;
    const originalSnap = (await prisma.transaction.findUnique({ where: { id: txId } })).balanceSnapshot;

    const configSnap = await snapshotConfig();
    try {
      await prisma.systemConfig.update({
        where: { id: 1 },
        data: { enableTransactionVoid: true, voidEnabledAt: new Date() },
      });
      const voided = await post(`/api/transactions/${txId}/void`, {
        token: adminToken, body: { reason: 'QA 撤销交易并核对快照' },
      });
      assert.equal(voided.status, 200, `撤销应成功: ${voided.status} ${voided.text}`);
      assert.equal(voided.json.success, true);
      const restored = voided.json.balanceRestored.find(x => x.cardId === card.id);
      assert.ok(restored, 'balanceRestored 必须包含被扣卡');
      assert.equal(dec(restored.amountRestored).toFixed(2), '10.00');
      assert.equal(dec(restored.newBalance).toFixed(2), '50.00');
      assert.equal((await cardBalance(card.id)).toFixed(2), '50.00');
      assert.equal(await prisma.transaction.count({ where: { id: txId } }), 0);

      const log = await prisma.voidLog.findFirst({ where: { originalTxId: txId } });
      assert.ok(log, '撤销日志必须落库');
      assert.equal(log.reason, 'QA 撤销交易并核对快照');
      assert.ok(log.voidedBy && log.voidedByName, '撤销操作人必须留痕');
      assert.deepEqual(log.balanceSnapshot, originalSnap,
        'VoidLog 必须完整保留原始交易的前后余额快照');
      // 快照是会员级合计（含其它有效卡），只断言字段齐备与前后差额
      assert.equal(typeof log.balanceSnapshot.totalBalanceBefore, 'number');
      assert.equal(typeof log.balanceSnapshot.totalBalanceAfter, 'number');
      assert.equal(dec(log.balanceSnapshot.totalBalanceBefore).minus(log.balanceSnapshot.totalBalanceAfter).toFixed(2), '10.00');
      assert.ok(Array.isArray(log.balanceSnapshot.cards));
      const used = log.balanceSnapshot.cards.find(c => c.cardId === card.id);
      assert.ok(used, '快照必须包含被扣减的卡');
      assert.equal(dec(used.balanceBefore).toFixed(2), '50.00');
      assert.equal(dec(used.balanceAfter).toFixed(2), '40.00');
      assert.equal(used.isUsed, true);
    } finally {
      await restoreConfig(configSnap);
    }
  });

  test('权限双层：交易撤销 STYLIST/ASSISTANT 403、未认证 401；系统配置仅 ADMIN 可改', async () => {
    const card = await makeCard('20.00');
    const created = await post('/api/transactions', { token: adminToken, body: txBody(card.id, 'rbac') });
    assert.equal(created.status, 200);
    const txId = created.json.id;
    for (const role of ['STYLIST', 'ASSISTANT']) {
      const r = await post(`/api/transactions/${txId}/void`, {
        token: tokenFor(role), body: { reason: 'QA 越权撤销' },
      });
      assert.equal(r.status, 403, `${role} 撤销应 403: ${r.status} ${r.text}`);
    }
    assert.equal((await post(`/api/transactions/${txId}/void`, {
      body: { reason: 'QA 未认证撤销' },
    })).status, 401);
    assert.equal((await cardBalance(card.id)).toFixed(2), '10.00', '越权撤销不得改动余额');

    for (const role of ['STYLIST', 'ASSISTANT', 'MANAGER']) {
      const r = await patch('/api/configs', { token: tokenFor(role), body: {} });
      assert.equal(r.status, 403, `${role} 改系统配置应 403: ${r.status} ${r.text}`);
    }
    const adminCfg = await patch('/api/configs', { token: adminToken, body: {} });
    assert.equal(adminCfg.status, 200, `ADMIN 空改配置应 200: ${adminCfg.status} ${adminCfg.text}`);
  });
});
