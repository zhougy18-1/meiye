import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { assertDedicatedMigrationTestDatabase } from './_testDbGuard.js';

process.env.NODE_ENV = 'test';
assertDedicatedMigrationTestDatabase();
const { default: prisma } = await import('../../src/db/prisma.js');
const { createMemberMigrationService } = await import('../../src/services/memberMigration.js');

const runToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.slice(-6);
const actor = { id: `migration-perf-${runToken}`, username: `migration-perf-${runToken}`, role: 'ADMIN' };
const service = createMemberMigrationService(prisma);
const ids = { card: `pc${runToken}`, service: `ps${runToken}`, plan: `pp${runToken}` };
const phonePrefix = String(1000 + (Number.parseInt(runToken, 36) % 8000)).padStart(4, '0');

async function workbookBase64(count) {
  const book = new ExcelJS.Workbook();
  const members = book.addWorksheet('会员基础信息');
  members.addRow(['会员编号','会员等级','姓名','手机号码','入会日期','备注']);
  const balances = book.addWorksheet('会员储值信息');
  balances.addRow(['会员编号','历史累计充值（元）','历史累计消费（元）','当前储值余额（元）','备注']);
  const courses = book.addWorksheet('会员护理疗程');
  courses.addRow(['会员编号','护理项目','购买次数','已用次数','剩余次数','备注']);
  const instructions = book.addWorksheet('填写说明'); instructions.addRow(['项目','填写要求','示例']);
  for (let index = 1; index <= count; index++) {
    const externalId = `${runToken}-${String(index).padStart(4, '0')}`;
    members.addRow([externalId, '历史分类', `压力测试会员${index}`, `136${phonePrefix}${String(index).padStart(4, '0')}`, '2024-01-01', '脱敏测试数据']);
    balances.addRow([externalId, '1000.00', '800.00', '200.00', '期初']);
    courses.addRow([externalId, '压力测试护理', 10, 6, 4, '期初']);
  }
  return Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
}

async function clear() {
  const batches = await prisma.memberMigrationBatch.findMany({ where: { createdBy: actor.id }, select: { id: true } });
  const batchIds = batches.map(item => item.id);
  await prisma.packageHolding.deleteMany({ where: { importBatchId: { in: batchIds } } });
  await prisma.card.deleteMany({ where: { importBatchId: { in: batchIds } } });
  await prisma.member.deleteMany({ where: { importBatchId: { in: batchIds } } });
  await prisma.memberMigrationBatch.deleteMany({ where: { id: { in: batchIds } } });
  await prisma.packagePlan.deleteMany({ where: { id: ids.plan } });
  await prisma.service.deleteMany({ where: { id: ids.service } });
  await prisma.cardType.deleteMany({ where: { id: ids.card } });
}

async function assertCleared() {
  const [batches, members, cards, holdings, plans, services, cardTypes] = await Promise.all([
    prisma.memberMigrationBatch.count({ where: { createdBy: actor.id } }),
    prisma.member.count({ where: { externalId: { startsWith: `${runToken}-` } } }),
    prisma.card.count({ where: { cardTypeId: ids.card } }),
    prisma.packageHolding.count({ where: { planId: ids.plan } }),
    prisma.packagePlan.count({ where: { id: ids.plan } }),
    prisma.service.count({ where: { id: ids.service } }),
    prisma.cardType.count({ where: { id: ids.card } }),
  ]);
  assert.deepEqual({ batches, members, cards, holdings, plans, services, cardTypes },
    { batches:0, members:0, cards:0, holdings:0, plans:0, services:0, cardTypes:0 }, '压力测试夹具必须全部清理');
}

test('300 名会员、300 笔余额和 300 条疗程在事务时限内完成并可回滚', async t => {
  await clear();
  t.after(async () => { try { await clear(); await assertCleared(); } finally { await prisma.$disconnect(); } });
  await prisma.cardType.create({ data: { id:ids.card, name:'压力测试卡', initialPrice:'0.00', discountRate:'1.000' } });
  await prisma.service.create({ data: { id:ids.service, name:'压力测试护理', standardPrice:'100.00' } });
  await prisma.packagePlan.create({ data: { id:ids.plan, name:'压力测试套餐', serviceId:ids.service, totalUses:10, price:'800.00', createdBy:actor.id } });
  const previewStartedAt = performance.now();
  const preview = await service.preview({ fileName:'300人压力测试.xlsx', fileBase64:await workbookBase64(300), cutoffAt:'2026-11-20T20:00:00+08:00', cardTypeId:ids.card, projectMappings:{'压力测试护理':ids.plan} }, actor);
  const previewDurationMs = Math.round(performance.now() - previewStartedAt);
  t.diagnostic(`300 人解析预览耗时 ${previewDurationMs}ms`);
  assert.ok(previewDurationMs < 10000, `300 人解析预览不应超过 10 秒，实际 ${previewDurationMs}ms`);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues.slice(0, 10)));
  const warnings = [...new Set(preview.issues.filter(issue => issue.severity === 'warning').map(issue => issue.code))];
  const startedAt = performance.now();
  const committed = await service.commit(preview.id, warnings, actor);
  const durationMs = Math.round(performance.now() - startedAt);
  t.diagnostic(`300 人正式导入耗时 ${durationMs}ms`);
  assert.ok(durationMs < 20000, `300 人正式导入不应超过 20 秒，实际 ${durationMs}ms`);
  assert.equal(committed.resultSummary.reconciled, true);
  assert.equal(committed.resultSummary.actual.memberCount, 300);
  assert.equal(committed.resultSummary.actual.cardCount, 300);
  assert.equal(committed.resultSummary.actual.holdingCount, 300);
  assert.equal(committed.resultSummary.actual.openingBalance, '60000.00');
  const rolledBack = await service.rollback(preview.id, '压力测试完成清理', actor);
  assert.equal(rolledBack.status, 'ROLLED_BACK');
  assert.equal(await prisma.member.count({ where: { importBatchId: preview.id } }), 0);
  assert.equal(await prisma.card.count({ where: { importBatchId: preview.id } }), 0);
  assert.equal(await prisma.packageHolding.count({ where: { importBatchId: preview.id } }), 0);
});
