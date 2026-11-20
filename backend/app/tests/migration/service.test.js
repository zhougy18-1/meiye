import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

process.env.NODE_ENV = 'test';
const { default: prisma } = await import('../../src/db/prisma.js');
const { createMemberMigrationService, MemberMigrationError } = await import('../../src/services/memberMigration.js');
const { createMigrationReportWorkbook } = await import('../../src/services/migrationExcel.js');
const actor = { id: 'migration-test-admin', username: 'migration-test-admin', role: 'ADMIN' };
const service = createMemberMigrationService(prisma);

async function workbookBase64() {
  const book = new ExcelJS.Workbook();
  const member = book.addWorksheet('会员基础信息');
  member.addRow(['会员编号','会员等级','姓名','手机号码','入会日期','备注']);
  member.addRow(['T001','老会员','测试会员','13912345678','2023-01-02','基础备注']);
  const balance = book.addWorksheet('会员储值信息');
  balance.addRow(['会员编号','历史累计充值（元）','历史累计消费（元）','当前储值余额（元）','备注']);
  balance.addRow(['T001','1000.00','700.00','350.00','包含调整']);
  const course = book.addWorksheet('会员护理疗程');
  course.addRow(['会员编号','护理项目','购买次数','已用次数','剩余次数','备注']);
  course.addRow(['T001','清洁护理',10,6,4,'期初']);
  const instructions = book.addWorksheet('填写说明'); instructions.addRow(['项目','填写要求','示例']);
  return Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
}

async function clear() {
  const batches = await prisma.memberMigrationBatch.findMany({ where: { createdBy: actor.id }, select: { id: true } });
  const ids = batches.map(x => x.id);
  await prisma.packageUsage.deleteMany({ where: { holding: { importBatchId: { in: ids } } } });
  await prisma.packageRefundAudit.deleteMany({ where: { holding: { importBatchId: { in: ids } } } });
  await prisma.packageHolding.deleteMany({ where: { importBatchId: { in: ids } } });
  await prisma.card.deleteMany({ where: { importBatchId: { in: ids } } });
  await prisma.member.deleteMany({ where: { importBatchId: { in: ids } } });
  await prisma.memberMigrationBatch.deleteMany({ where: { id: { in: ids } } });
  await prisma.packagePlan.deleteMany({ where: { id: 'migplan' } });
  await prisma.service.deleteMany({ where: { id: 'migsvc01' } });
  await prisma.cardType.deleteMany({ where: { id: 'migcard1' } });
}

test('预览、确认、期初建账、经营隔离与安全回滚形成闭环', async t => {
  await clear(); t.after(async () => { await clear(); await prisma.$disconnect(); });
  await prisma.cardType.create({ data: { id:'migcard1', name:'迁移测试卡', initialPrice:'0.00', discountRate:'1.000' } });
  await prisma.service.create({ data: { id:'migsvc01', name:'迁移测试清洁', standardPrice:'100.00' } });
  await prisma.packagePlan.create({ data: { id:'migplan', name:'迁移测试套餐', serviceId:'migsvc01', totalUses:10, price:'800.00', createdBy:actor.id } });
  const preview = await service.preview({ fileName:'测试.xlsx', fileBase64:await workbookBase64(), cutoffAt:'2026-11-20T20:00:00+08:00', cardTypeId:'migcard1', projectMappings:{'清洁护理':'migplan'} }, actor);
  assert.equal(preview.canCommit, true);
  assert.equal(preview.summary.openingBalance, '350.00');
  const warnings = [...new Set(preview.issues.filter(x => x.severity === 'warning').map(x => x.code))];
  const committed = await service.commit(preview.id, warnings, actor);
  assert.equal(committed.status, 'COMMITTED');
  assert.equal(committed.resultSummary.reconciled, true);
  assert.equal(committed.resultSummary.actual.openingBalance, '350.00');
  assert.deepEqual(committed.resultSummary.reconciliation, { memberCount:0, courseRecordCount:0, historicalRecharge:'0.00', historicalConsumption:'0.00', openingBalance:'0.00' });
  assert.deepEqual(committed.resultSummary.projectReconciliation['清洁护理'], { records:0, purchased:0, used:0, remaining:0, unknownPurchased:0, unknownUsed:0 });
  const [member, card, holding, txCount] = await Promise.all([
    prisma.member.findUnique({ where:{ externalId:'T001' } }),
    prisma.card.findFirst({ where:{ importBatchId:preview.id } }),
    prisma.packageHolding.findFirst({ where:{ importBatchId:preview.id } }),
    prisma.transaction.count({ where:{ member:{ externalId:'T001' } } }),
  ]);
  assert.equal(member.classification, '老会员');
  assert.equal(member.historicalRecharge.toFixed(2), '1000.00');
  assert.equal(card.balance.toFixed(2), '350.00');
  assert.equal(holding.source, 'OPENING');
  assert.equal(holding.remainingUses, 4);
  assert.equal(holding.paidAmount.toFixed(2), '0.00');
  assert.equal(txCount, 0);
  const duplicatePreview = await service.preview({ fileName:'改名.xlsx', fileBase64:await workbookBase64(), cutoffAt:'2026-11-20T20:00:00+08:00', cardTypeId:'migcard1', projectMappings:{'清洁护理':'migplan'} }, actor);
  await assert.rejects(service.commit(duplicatePreview.id, [...new Set(duplicatePreview.issues.filter(x=>x.severity==='warning').map(x=>x.code))], actor), error => error instanceof MemberMigrationError && error.statusCode === 409);
  const reportBuffer = await createMigrationReportWorkbook(await service.get(preview.id));
  const report = new ExcelJS.Workbook(); await report.xlsx.load(reportBuffer);
  assert.deepEqual(report.worksheets.map(sheet => sheet.name), ['批次对账','异常与确认项','疗程汇总']);
  assert.equal(report.getWorksheet('批次对账').getCell('B13').value, '一致');
  await prisma.card.update({ where:{ id:card.id }, data:{ balance:'349.00' } });
  await assert.rejects(service.rollback(preview.id, '余额变化不能回滚', actor), error => error instanceof MemberMigrationError && error.statusCode === 409);
  await prisma.card.update({ where:{ id:card.id }, data:{ balance:'350.00' } });
  const rolledBack = await service.rollback(preview.id, '测试回滚', actor);
  assert.equal(rolledBack.status, 'ROLLED_BACK');
  assert.equal(await prisma.member.count({ where:{ externalId:'T001' } }), 0);
});
