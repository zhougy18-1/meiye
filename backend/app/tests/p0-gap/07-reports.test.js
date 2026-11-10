// 测试 7/9：统一报表口径 —— /business 与 /business/monthly 的
// packageRevenue / packageRefund / redeemedUses 与源数据勾稽一致，绝不并入 totalRevenue
// 覆盖 AC-03/AC-04、架构陷阱 T-02、routes/reports.js
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  prisma, createScope, Decimal, ROLES, get, tokenFor, DEMO, dec,
  shopDayRange, shopMonthWindow, shopMonthKey,
} from './_helpers.js';

const scope = createScope('p07');
const adminToken = tokenFor('ADMIN');
const QUERY = { startDate: '2026-11-01', endDate: '2026-11-30' };
let memberId;
let beforeReport;
let txCountBefore;
let created = {};

before(async () => {
  await scope.cleanup();
  const m = await prisma.member.create({ data: {
    id: scope.key('member'), phone: scope.qaPhone(), name: 'QA-报表勾稽', status: 'ACTIVE',
  } });
  memberId = m.id;

  beforeReport = await get('/api/reports/business', { token: adminToken, query: QUERY });
  assert.equal(beforeReport.status, 200);
  txCountBefore = await prisma.transaction.count();

  const mkHolding = (paidAmount, purchasedAt) => prisma.packageHolding.create({ data: {
    memberId, planId: DEMO.planId, planName: 'QA 报表套餐',
    totalUses: 5, remainingUses: 5, paidAmount, status: 'ACTIVE',
    paymentMethod: 'CASH', purchasedAt, createdBy: ROLES.ADMIN.id,
    createdByName: ROLES.ADMIN.username, requestKey: scope.key('holding'),
  } });

  const h1 = await mkHolding('12.34', new Date('2026-11-10T02:00:00.000Z'));
  const h2 = await mkHolding('7.66', new Date('2026-11-15T04:00:00.000Z'));
  await prisma.packageRefundAudit.create({ data: {
    holdingId: h1.id, action: 'REFUND', refundAmount: '3.21',
    remainingUsesBefore: 5, remainingUsesAfter: 0, prevStatus: 'ACTIVE',
    reason: 'QA 报表勾稽退款', approvedBy: 'QA 审批',
    operatorId: ROLES.ADMIN.id, operatorName: ROLES.ADMIN.username,
    occurredAt: new Date('2026-11-12T03:00:00.000Z'),
    requestKey: scope.key('audit'),
  } });

  const mkUsage = (holdingId, usedAt, reversedAt) => prisma.packageUsage.create({ data: {
    holdingId, requestKey: scope.key('usage'), usedAt, reversedAt,
    usedBy: ROLES.ADMIN.id, usedByName: ROLES.ADMIN.username, note: 'QA 报表履约',
  } });
  await mkUsage(h2.id, new Date('2026-11-05T02:00:00.000Z'), null);
  await mkUsage(h2.id, new Date('2026-11-06T02:00:00.000Z'), null);
  await mkUsage(h2.id, new Date('2026-11-07T02:00:00.000Z'), null);
  // 已撤销 → 不计入履约次数
  await mkUsage(h2.id, new Date('2026-11-08T02:00:00.000Z'), new Date('2026-11-08T03:00:00.000Z'));
  // 窗口外 → 不计入
  await mkUsage(h2.id, new Date('2026-10-30T02:00:00.000Z'), null);
  created = { h1, h2 };
});
after(async () => { await scope.cleanup(); await prisma.$disconnect(); });

async function expectedPackageMetrics(start, end) {
  const [holdings, refunds, usages] = await Promise.all([
    prisma.packageHolding.findMany({
      where: { purchasedAt: { gte: start, lte: end } }, select: { paidAmount: true },
    }),
    prisma.packageRefundAudit.findMany({
      where: { occurredAt: { gte: start, lte: end } }, select: { refundAmount: true },
    }),
    prisma.packageUsage.findMany({
      where: { usedAt: { gte: start, lte: end }, reversedAt: null }, select: { id: true },
    }),
  ]);
  const sum = (rows, field) => rows.reduce((acc, r) => acc.plus(dec(r[field])), new Decimal(0));
  return {
    packageRevenue: sum(holdings, 'paidAmount').toFixed(2),
    packageRefund: sum(refunds, 'refundAmount').toFixed(2),
    redeemedUses: usages.length,
  };
}
/** 月度分桶口径：与 reports.js 的 packageRowsForMonth 一致（按 shopMonthKey 过滤）。 */
async function expectedPackageMetricsForMonth(start, end, month) {
  const [holdings, refunds, usages] = await Promise.all([
    prisma.packageHolding.findMany({
      where: { purchasedAt: { gte: start, lte: end } }, select: { paidAmount: true, purchasedAt: true },
    }),
    prisma.packageRefundAudit.findMany({
      where: { occurredAt: { gte: start, lte: end } }, select: { refundAmount: true, occurredAt: true },
    }),
    prisma.packageUsage.findMany({
      where: { usedAt: { gte: start, lte: end }, reversedAt: null }, select: { usedAt: true },
    }),
  ]);
  const inMonth = r => shopMonthKey(r.purchasedAt || r.occurredAt || r.usedAt) === month;
  const sum = (rows, field) => rows.reduce((acc, r) => acc.plus(dec(r[field])), new Decimal(0));
  return {
    packageRevenue: sum(holdings.filter(inMonth), 'paidAmount').toFixed(2),
    packageRefund: sum(refunds.filter(inMonth), 'refundAmount').toFixed(2),
    redeemedUses: usages.filter(inMonth).length,
  };
}
async function expectedTotalRevenue(start, end) {
  const txs = await prisma.transaction.findMany({
    where: { transactionTime: { gte: start, lte: end } },
  });
  return txs
    .filter(t => t.transactionType !== 'PENDING_CLEAR' && t.transactionType !== 'CARD_PURCHASE')
    .reduce((acc, t) => acc.plus(dec(t.actualPaidAmount).abs()), new Decimal(0))
    .toFixed(2);
}

describe('AC-03/AC-04 报表三列分列且勾稽一致', () => {
  test('/business：三列与源数据逐笔勾稽；金额两位小数字符串、履约次数整数；既有四列不回归', async (t) => {
    const { start, end } = shopDayRange(QUERY.startDate, QUERY.endDate);
    const expected = await expectedPackageMetrics(start, end);
    const expectedRevenue = await expectedTotalRevenue(start, end);

    const r = await get('/api/reports/business', { token: adminToken, query: QUERY });
    assert.equal(r.status, 200, `报表应 200: ${r.status} ${r.text}`);
    const b = r.json;
    assert.equal(b.packageRevenue, expected.packageRevenue, '套餐实收必须与窗口内 PackageHolding.paidAmount 之和一致');
    assert.equal(b.packageRefund, expected.packageRefund, '套餐退款必须与窗口内 PackageRefundAudit.refundAmount 之和一致');
    assert.equal(b.redeemedUses, expected.redeemedUses, '履约次数必须等于窗口内未撤销 PackageUsage 条数');

    // 相对基线勾稽：QA 新增 12.34 + 7.66 = 20.00 实收 / 3.21 退款 / 3 次未撤销履约。
    // 用 beforeReport（本文件写入前抓取）作基数，避免依赖其它用例是否残留 QA 数据。
    assert.equal(b.packageRevenue, dec(beforeReport.json.packageRevenue).plus('20.00').toFixed(2));
    assert.equal(b.packageRefund, dec(beforeReport.json.packageRefund).plus('3.21').toFixed(2));
    assert.equal(b.redeemedUses, beforeReport.json.redeemedUses + 3);
    t.diagnostic(`QA_REPORT_BEFORE=${JSON.stringify(beforeReport.json)}`);
    t.diagnostic(`QA_REPORT_AFTER=${JSON.stringify(b)}`);

    assert.match(b.packageRevenue, /^\d+\.\d{2}$/);
    assert.match(b.packageRefund, /^\d+\.\d{2}$/);
    assert.equal(Number.isInteger(b.redeemedUses), true);

    // packageRevenue 绝不并入 totalRevenue
    assert.equal(b.totalRevenue, expectedRevenue, 'totalRevenue 必须只由 Transaction 计算');
    assert.equal(b.totalRevenue, beforeReport.json.totalRevenue,
      '新增套餐/退款/履约数据不得改变 totalRevenue');
    assert.equal(await prisma.transaction.count(), txCountBefore,
      '套餐台账写入不得产生任何旧 Transaction');
    assert.notEqual(b.totalRevenue, dec(b.totalRevenue).plus(b.packageRevenue).toFixed(2));

    // 既有四列 + 客单价 / 客数 不回归
    for (const k of ['totalRevenue', 'pendingAmount', 'cardConsumption', 'totalRecharge', 'averageOrderValue']) {
      assert.equal(typeof b[k], 'string', `${k} 必须为字符串`);
      assert.match(b[k], /^\d+\.\d{2}$/, `${k} 必须是两位小数字符串`);
    }
    assert.equal(typeof b.totalCustomers, 'number');
    assert.equal(b.totalRevenue, beforeReport.json.totalRevenue);
    assert.equal(b.pendingAmount, beforeReport.json.pendingAmount);
    assert.equal(b.cardConsumption, beforeReport.json.cardConsumption);
    assert.equal(b.totalRecharge, beforeReport.json.totalRecharge);
  });

  test('/business/monthly：12 个月均含三列（T-02 响应 schema 未剥离），当月口径与 /business 一致', async (t) => {
    const { months, start, end } = shopMonthWindow(12);
    const expectedNov = await expectedPackageMetricsForMonth(start, end, '2026-11');
    const expectedRevenueNov = await expectedTotalRevenue(
      shopDayRange('2026-11-01', '2026-11-30').start,
      shopDayRange('2026-11-01', '2026-11-30').end,
    );

    const r = await get('/api/reports/business/monthly', { token: adminToken });
    assert.equal(r.status, 200, `月度报表应 200: ${r.status} ${r.text}`);
    assert.ok(Array.isArray(r.json));
    assert.equal(r.json.length, 12);
    for (const row of r.json) {
      assert.equal(typeof row.packageRevenue, 'string', 'monthly 必须显式声明并返回 packageRevenue');
      assert.equal(typeof row.packageRefund, 'string', 'monthly 必须显式声明并返回 packageRefund');
      assert.equal(typeof row.redeemedUses, 'number', 'monthly 必须显式声明并返回 redeemedUses');
      assert.match(row.packageRevenue, /^\d+\.\d{2}$/);
      assert.match(row.packageRefund, /^\d+\.\d{2}$/);
      assert.equal(Number.isInteger(row.redeemedUses), true);
      assert.match(String(row.month), /^\d{4}-\d{2}$/);
    }
    assert.deepEqual(r.json.map(x => x.month), months);

    const nov = r.json.find(x => x.month === '2026-11');
    assert.ok(nov, '必须包含当月分桶');
    assert.equal(nov.packageRevenue, expectedNov.packageRevenue, '月度套餐实收必须按门店月份分桶勾稽');
    assert.equal(nov.packageRefund, expectedNov.packageRefund);
    assert.equal(nov.redeemedUses, expectedNov.redeemedUses,
      '月度履约次数只统计该月 usedAt 且未撤销的记录（窗口外的 2026-10 记录不得计入）');
    assert.equal(nov.totalRevenue, expectedRevenueNov, '月度 totalRevenue 仍不含套餐收入');
    assert.equal(nov.packageRevenue, dec(beforeReport.json.packageRevenue).plus('20.00').toFixed(2),
      '月度与 /business 同口径');
    assert.equal(nov.packageRefund, dec(beforeReport.json.packageRefund).plus('3.21').toFixed(2));
    assert.equal(nov.redeemedUses, beforeReport.json.redeemedUses + 3);
    t.diagnostic(`QA_MONTHLY_NOV=${JSON.stringify(nov)}`);

    // 口径一致性：窗口内 QA 数据的门店月份分桶
    for (const h of [created.h1, created.h2]) {
      assert.equal(shopMonthKey(h.purchasedAt), '2026-11');
    }
  });

  test('边界：开始日期晚于结束日期返回 400；缺日期参数返回 400', async () => {
    const bad = await get('/api/reports/business', {
      token: adminToken, query: { startDate: '2026-12-30', endDate: '2026-11-01' },
    });
    assert.equal(bad.status, 400, `日期倒置应 400: ${bad.status} ${bad.text}`);
    const missing = await get('/api/reports/business', { token: adminToken, query: {} });
    assert.equal(missing.status, 400);
  });
});
