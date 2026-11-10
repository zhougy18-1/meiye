// 测试 6/9：退款 / 作废 + 审计留痕 + 幂等 + 权限双层矩阵（架构 §6 / AC-01/02/07）
// 注意：refund/void 的 manager 守卫挂在 preHandler，Fastify 参数校验在其之前，
// 因此测 403 必须使用「完整合法 body」，否则会先得到 400 而掩盖权限问题。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  prisma, createScope, ROLES, post, get, patch, tokenFor, DEMO, dec,
} from './_helpers.js';

const scope = createScope('p06');
const adminToken = tokenFor('ADMIN');
const managerToken = tokenFor('MANAGER');
let memberId;

before(async () => {
  await scope.cleanup();
  const m = await prisma.member.create({ data: {
    id: scope.key('member'), phone: scope.qaPhone(), name: 'QA-退款作废', status: 'ACTIVE',
  } });
  memberId = m.id;
});
after(async () => { await scope.cleanup(); await prisma.$disconnect(); });

async function makeHolding({ totalUses = 3, remainingUses = 2, paidAmount = '99.00', status = 'ACTIVE' } = {}) {
  return prisma.packageHolding.create({ data: {
    memberId, planId: DEMO.planId, planName: 'QA 退款作废套餐',
    totalUses, remainingUses, paidAmount, status, paymentMethod: 'CASH',
    purchasedAt: new Date(), createdBy: ROLES.ADMIN.id,
    createdByName: ROLES.ADMIN.username, requestKey: scope.key('holding'),
  } });
}
async function addUsage(holdingId, reversed = false) {
  return prisma.packageUsage.create({ data: {
    holdingId, requestKey: scope.key('usage'), usedAt: new Date(),
    usedBy: ROLES.ADMIN.id, usedByName: ROLES.ADMIN.username, note: 'QA 历史履约',
    reversedAt: reversed ? new Date() : null,
    reversedBy: reversed ? ROLES.ADMIN.id : null,
    reversedByName: reversed ? ROLES.ADMIN.username : null,
    reverseReason: reversed ? 'QA 历史撤销' : null,
  } });
}
const refundBody = (requestKey, refundAmount = '30.00') => ({
  requestKey, refundAmount, reason: 'QA 顾客申请退款', approvedBy: 'QA 店长审批',
});
const voidBody = (requestKey) => ({
  requestKey, reason: 'QA 录入错误作废', approvedBy: 'QA 店长审批',
});

describe('AC-01/AC-02 退款 / 作废', () => {
  test('REFUND：状态 REFUNDED、次数归零、审计字段齐备、购买快照不变、历史履约不删、不写旧 Transaction', async () => {
    const holding = await makeHolding();
    const u1 = await addUsage(holding.id, false);
    const u2 = await addUsage(holding.id, true);
    const before = await prisma.packageHolding.findUnique({ where: { id: holding.id } });
    const txCountBefore = await prisma.transaction.count();

    const requestKey = scope.key('refund');
    const r = await post(`/api/packages/holdings/${holding.id}/refund`, {
      token: adminToken, body: refundBody(requestKey),
    });
    assert.equal(r.status, 200, `退款应成功: ${r.status} ${r.text}`);
    assert.equal(r.json.holding.status, 'REFUNDED');
    assert.equal(r.json.holding.remainingUses, 0);

    const after = await prisma.packageHolding.findUnique({ where: { id: holding.id } });
    assert.equal(after.status, 'REFUNDED');
    assert.equal(after.remainingUses, 0);
    assert.equal(after.planName, before.planName, '购买快照（名称）不得改动');
    assert.equal(after.totalUses, before.totalUses, '购买快照（总次数）不得改动');
    assert.equal(dec(after.paidAmount).toFixed(2), dec(before.paidAmount).toFixed(2),
      '购买快照（实收金额）不得改动');
    assert.equal(String(after.expiresAt), String(before.expiresAt));
    assert.equal(String(after.purchasedAt), String(before.purchasedAt));

    const audits = await prisma.packageRefundAudit.findMany({ where: { holdingId: holding.id } });
    assert.equal(audits.length, 1);
    const a = audits[0];
    assert.equal(a.action, 'REFUND');
    assert.equal(dec(a.refundAmount).toFixed(2), '30.00');
    assert.equal(a.remainingUsesBefore, 2);
    assert.equal(a.remainingUsesAfter, 0);
    assert.equal(a.prevStatus, 'ACTIVE');
    assert.equal(a.reason, 'QA 顾客申请退款');
    assert.equal(a.approvedBy, 'QA 店长审批');
    assert.equal(a.operatorId, ROLES.ADMIN.id);
    assert.equal(a.operatorName, ROLES.ADMIN.username);
    assert.ok(a.occurredAt instanceof Date, '时间必须由系统记录');
    assert.equal(a.requestKey, requestKey);

    const usages = await prisma.packageUsage.findMany({ where: { holdingId: holding.id } });
    assert.equal(usages.length, 2, '历史 PackageUsage 不得被删除');
    assert.equal((await prisma.packageUsage.findUnique({ where: { id: u1.id } })).reversedAt, null);
    assert.ok((await prisma.packageUsage.findUnique({ where: { id: u2.id } })).reversedAt instanceof Date);
    assert.equal(await prisma.transaction.count(), txCountBefore, '退款不得写入旧 Transaction 收银流水');
  });

  test('已退款卡：不可再扣次、不可重复退款、不可逆改状态；同 requestKey 幂等返回同一审计', async () => {
    const holding = await makeHolding();
    const requestKey = scope.key('refund-idempotent');
    const first = await post(`/api/packages/holdings/${holding.id}/refund`, {
      token: adminToken, body: refundBody(requestKey),
    });
    assert.equal(first.status, 200);

    const redeem = await post(`/api/packages/holdings/${holding.id}/redeem`, {
      token: adminToken, body: { requestKey: scope.key('redeem-after-refund') },
    });
    assert.equal(redeem.status, 409, `终态卡不得扣次: ${redeem.status} ${redeem.text}`);
    assert.equal(await prisma.packageUsage.count({ where: { holdingId: holding.id } }), 0);

    const again = await post(`/api/packages/holdings/${holding.id}/refund`, {
      token: adminToken, body: refundBody(scope.key('refund-again')),
    });
    assert.equal(again.status, 409, `已退款卡不得再次退款: ${again.status} ${again.text}`);
    assert.match(again.text, /已退款或作废/);

    const statusPatch = await patch(`/api/packages/holdings/${holding.id}/status`, {
      token: adminToken, body: { status: 'ACTIVE' },
    });
    assert.equal(statusPatch.status, 409, `终态不可逆: ${statusPatch.status} ${statusPatch.text}`);

    const idem = await post(`/api/packages/holdings/${holding.id}/refund`, {
      token: adminToken, body: refundBody(requestKey),
    });
    assert.equal(idem.status, 200, `同 requestKey 应幂等: ${idem.status} ${idem.text}`);
    assert.equal(idem.json.audit.id, first.json.audit.id, '必须返回同一条审计，不得重复记账');
    assert.equal(await prisma.packageRefundAudit.count({ where: { holdingId: holding.id } }), 1);
    assert.equal((await prisma.packageHolding.findUnique({ where: { id: holding.id } })).status, 'REFUNDED');
  });

  test('VOID：状态 VOID、无退款金额、次数归零、审计 action=VOID；MANAGER 亦可操作', async () => {
    const h1 = await makeHolding();
    const r1 = await post(`/api/packages/holdings/${h1.id}/void`, {
      token: adminToken, body: voidBody(scope.key('void-admin')),
    });
    assert.equal(r1.status, 200, `作废应成功: ${r1.status} ${r1.text}`);
    assert.equal(r1.json.holding.status, 'VOID');
    assert.equal(r1.json.holding.remainingUses, 0);
    const a1 = await prisma.packageRefundAudit.findFirst({ where: { holdingId: h1.id } });
    assert.equal(a1.action, 'VOID');
    assert.equal(dec(a1.refundAmount).toFixed(2), '0.00');
    assert.equal(a1.remainingUsesAfter, 0);

    const h2 = await makeHolding();
    const r2 = await post(`/api/packages/holdings/${h2.id}/void`, {
      token: managerToken, body: voidBody(scope.key('void-manager')),
    });
    assert.equal(r2.status, 200, `MANAGER 作废应成功: ${r2.status} ${r2.text}`);
    assert.equal((await prisma.packageHolding.findUnique({ where: { id: h2.id } })).status, 'VOID');
  });

  test('边界：超额退款 400、缺审批人 400、作废忽略多传金额、不存在资源 404', async () => {
    const hOver = await makeHolding();
    const over = await post(`/api/packages/holdings/${hOver.id}/refund`, {
      token: adminToken, body: refundBody(scope.key('refund-over'), '999.00'),
    });
    assert.equal(over.status, 400, `超额退款应 400: ${over.status} ${over.text}`);
    assert.match(over.text, /可退上限/);
    assert.equal((await prisma.packageHolding.findUnique({ where: { id: hOver.id } })).status, 'ACTIVE');
    assert.equal(await prisma.packageRefundAudit.count({ where: { holdingId: hOver.id } }), 0);

    const hMissing = await makeHolding();
    const missing = await post(`/api/packages/holdings/${hMissing.id}/refund`, {
      token: adminToken, body: {
        requestKey: scope.key('refund-no-approver'), refundAmount: '10.00', reason: 'QA 缺审批人',
      },
    });
    assert.equal(missing.status, 400, `缺 approvedBy 应 400: ${missing.status} ${missing.text}`);

    // Fastify 默认 Ajv `removeAdditional:true`：`additionalProperties:false` 会「剥离」而非拒绝多余字段。
    // 因此作废接口收到的多余 refundAmount 会被静默丢弃，审计金额必须仍为 0.00（作废无退款金额）。
    const hExtra = await makeHolding();
    const extra = await post(`/api/packages/holdings/${hExtra.id}/void`, {
      token: adminToken, body: { ...voidBody(scope.key('void-extra')), refundAmount: '10.00' },
    });
    assert.equal(extra.status, 200, `作废应成功: ${extra.status} ${extra.text}`);
    assert.equal(dec(extra.json.audit.refundAmount).toFixed(2), '0.00',
      '作废不得因多传金额而产生退款金额');
    assert.equal(extra.json.holding.status, 'VOID');

    for (const role of ['ADMIN', 'MANAGER']) {
      const r = await post('/api/packages/holdings/qa-no-such-holding/refund', {
        token: tokenFor(role), body: refundBody(scope.key('refund-404')),
      });
      assert.equal(r.status, 404, `${role} 对不存在资源应 404: ${r.status} ${r.text}`);
    }
  });
});

describe('AC-07 权限双层矩阵（后端 403，不依赖前端隐藏）', () => {
  test('refund / void：ADMIN·MANAGER 200，STYLIST·ASSISTANT 403，未认证 401（完整合法 body）', async () => {
    // 每个权限探测都用独立 holding，避免状态互相影响
    for (const endpoint of ['refund', 'void']) {
      const legal = endpoint === 'refund'
        ? () => refundBody(scope.key('rbac-refund'))
        : () => voidBody(scope.key('rbac-void'));

      for (const role of ['STYLIST', 'ASSISTANT']) {
        const h = await makeHolding();
        const r = await post(`/api/packages/holdings/${h.id}/${endpoint}`, {
          token: tokenFor(role), body: legal(),
        });
        assert.equal(r.status, 403, `${role} ${endpoint} 应 403（注意校验顺序陷阱）: ${r.status} ${r.text}`);
        assert.equal((await prisma.packageHolding.findUnique({ where: { id: h.id } })).status, 'ACTIVE');
        assert.equal(await prisma.packageRefundAudit.count({ where: { holdingId: h.id } }), 0);
      }
      const hNoAuth = await makeHolding();
      assert.equal((await post(`/api/packages/holdings/${hNoAuth.id}/${endpoint}`, {
        body: legal(),
      })).status, 401);
      assert.equal((await prisma.packageHolding.findUnique({ where: { id: hNoAuth.id } })).status, 'ACTIVE');

      const hAdmin = await makeHolding();
      assert.equal((await post(`/api/packages/holdings/${hAdmin.id}/${endpoint}`, {
        token: adminToken, body: legal(),
      })).status, 200);
      const hManager = await makeHolding();
      assert.equal((await post(`/api/packages/holdings/${hManager.id}/${endpoint}`, {
        token: managerToken, body: legal(),
      })).status, 200);
    }
  });

  test('audits 四级可读 200 / 未认证 401；status 变更低权限 403；redeem 四级可读可扣 200', async () => {
    const h = await makeHolding({ totalUses: 6, remainingUses: 6 });
    await post(`/api/packages/holdings/${h.id}/refund`, {
      token: adminToken, body: refundBody(scope.key('rbac-audit')),
    });
    for (const role of ['ADMIN', 'MANAGER', 'STYLIST', 'ASSISTANT']) {
      const r = await get(`/api/packages/holdings/${h.id}/audits`, { token: tokenFor(role) });
      assert.equal(r.status, 200, `${role} 读取审计应 200: ${r.status} ${r.text}`);
      assert.ok(Array.isArray(r.json) && r.json.length === 1);
    }
    assert.equal((await get(`/api/packages/holdings/${h.id}/audits`)).status, 401);

    const h2 = await makeHolding();
    for (const role of ['STYLIST', 'ASSISTANT']) {
      const r = await patch(`/api/packages/holdings/${h2.id}/status`, {
        token: tokenFor(role), body: { status: 'PAUSED' },
      });
      assert.equal(r.status, 403, `${role} 改次卡状态应 403: ${r.status} ${r.text}`);
    }
    assert.equal((await prisma.packageHolding.findUnique({ where: { id: h2.id } })).status, 'ACTIVE');

    const h3 = await makeHolding({ totalUses: 6, remainingUses: 6 });
    for (const role of ['ADMIN', 'MANAGER', 'STYLIST', 'ASSISTANT']) {
      const r = await post(`/api/packages/holdings/${h3.id}/redeem`, {
        token: tokenFor(role), body: { requestKey: scope.key('rbac-redeem') },
      });
      assert.equal(r.status, 200, `${role} 扣次应 200: ${r.status} ${r.text}`);
    }
    assert.equal((await prisma.packageHolding.findUnique({ where: { id: h3.id } })).remainingUses, 2);
  });

  test('经营报表 / 短信台账 / 系统配置：STYLIST·ASSISTANT 一律 403，未认证 401', async () => {
    const q = { startDate: '2026-11-01', endDate: '2026-11-30' };
    const paths = [
      ['/api/reports/business', q],
      ['/api/reports/business/monthly', null],
      ['/api/sms-notifications', null],
      ['/api/sms-notifications/config', null],
    ];
    for (const [p, query] of paths) {
      for (const role of ['STYLIST', 'ASSISTANT']) {
        const r = await get(p, { token: tokenFor(role), query });
        assert.equal(r.status, 403, `${role} GET ${p} 应 403: ${r.status} ${r.text}`);
      }
      assert.equal((await get(p, { query })).status, 401);
      assert.equal((await get(p, { token: adminToken, query })).status, 200);
      assert.equal((await get(p, { token: managerToken, query })).status, 200);
    }
  });
});
