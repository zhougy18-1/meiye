import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createTemplateWorkbook, parseWorkbook, parseMoney, parseCount, parseDate, inspectXlsxArchive, MIGRATION_SHEETS, EXCEL_LIMITS } from '../../src/services/migrationExcel.js';

async function fixture(modify = () => {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createTemplateWorkbook());
  workbook.getWorksheet('会员基础信息').addRow(['0001', 'VIP分类', '测试会员', '13800000001', '2024-02-29', '基础备注']);
  workbook.getWorksheet('会员储值信息').addRow(['0001', 10000, 7500, 2500, '储值备注']);
  workbook.getWorksheet('会员护理疗程').addRow(['0001', '深层清洁', 10, 6, 4, '疗程备注']);
  await modify(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const has = (result, code) => result.issues.some(issue => issue.code === code);

test('模板字段严格匹配最终 Excel，空数据及说明示例不会被导入', async () => {
  const buffer = await createTemplateWorkbook();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.worksheets.length, 4);
  for (const spec of Object.values(MIGRATION_SHEETS)) assert.deepEqual(workbook.getWorksheet(spec.name).getRow(1).values.slice(1), spec.headers);
  const result = await parseWorkbook(buffer);
  assert.equal(result.members.length, 0);
  assert.ok(has(result, 'EMPTY_WORKBOOK'));
});

test('正确保留编号前导零、分类标签、三类备注及精确金额', async () => {
  const result = await parseWorkbook(await fixture());
  assert.deepEqual(result.issues, []);
  assert.equal(result.members[0].externalId, '0001');
  assert.equal(result.members[0].classification, 'VIP分类');
  assert.equal(result.members[0].registrationDate, '2024-02-29');
  assert.equal(result.members[0].notes, '基础备注');
  assert.equal(result.balances[0].notes, '储值备注');
  assert.equal(result.courses[0].notes, '疗程备注');
  assert.equal(result.balances[0].balance, '2500.00');
  assert.equal(result.courses[0].remaining, 4);
});

test('表头允许调整顺序及首尾空格，不按固定列号误读', async () => {
  const result = await parseWorkbook(await fixture(w => {
    const sheet = w.getWorksheet('会员基础信息');
    sheet.getRow(1).values = [' 姓名 ', '会员等级', '会员编号', '手机号码', '入会日期', '备注'];
    sheet.getRow(2).values = ['测试会员', '普通', '0001', '13800000001', '', ''];
  }));
  assert.equal(result.members[0].name, '测试会员');
  assert.equal(result.members[0].externalId, '0001');
  assert.equal(result.members[0].registrationDate, null);
  assert.ok(!result.issues.some(i => i.severity === 'error'));
});

test('金额和次数拒绝负数、精度溢出及浮点误差，不把未知值转换成零', () => {
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney('0'), '0.00');
  assert.equal(parseMoney('0.10'), '0.10');
  for (const value of [-1, '1.001', '1e3', 'NaN', '100000000']) assert.throws(() => parseMoney(value));
  assert.equal(parseCount('0'), 0);
  assert.equal(parseCount(''), null);
  for (const value of [-1, '1.5', '2147483648']) assert.throws(() => parseCount(value));
});

test('日期使用明确格式与有效日历，拒绝 Excel 虚构闰日和模糊文本', () => {
  assert.equal(parseDate(null), null);
  assert.equal(parseDate(61), '1900-03-01');
  assert.equal(parseDate(1), '1900-01-01');
  assert.equal(parseDate(1, true), '1904-01-02');
  assert.equal(parseDate(new Date('2024-02-29T00:00:00Z')), '2024-02-29');
  for (const value of [60, '2023-02-29', '2024-13-01', '02/03/2024', 1.5]) assert.throws(() => parseDate(value));
});

test('结构缺失、重复字段和未知列均阻断且定位到工作表', async () => {
  const result = await parseWorkbook(await fixture(w => {
    const sheet = w.getWorksheet('会员基础信息');
    sheet.getCell('B1').value = '会员编号';
    sheet.getCell('G1').value = '未确认字段';
    sheet.getCell('H2').value = '无标题内容';
    w.removeWorksheet(w.getWorksheet('会员储值信息').id);
  }));
  for (const code of ['DUPLICATE_HEADER', 'MISSING_HEADER', 'UNKNOWN_HEADER', 'MISSING_SHEET']) assert.ok(has(result, code), code);
});

test('未知与零保留区别，历史和余额差异不自动改写', async () => {
  const result = await parseWorkbook(await fixture(w => {
    w.getWorksheet('会员基础信息').getCell('D2').value = null;
    w.getWorksheet('会员储值信息').getRow(2).values = ['0001', 100, 20, 90, '含赠送'];
    w.getWorksheet('会员护理疗程').getRow(2).values = ['0001', '深层清洁', null, null, 0, ''];
  }));
  assert.ok(has(result, 'MISSING_PHONE'));
  assert.ok(has(result, 'BALANCE_DIFFERENCE'));
  assert.equal(result.balances[0].balance, '90.00');
  assert.equal(result.courses[0].purchased, null);
  assert.equal(result.courses[0].used, null);
  assert.equal(result.courses[0].remaining, 0);
  assert.equal(result.summary.projects[0].unknownPurchased, 1);
});

test('余额及剩余次数未知阻断，不用算式补齐', async () => {
  const result = await parseWorkbook(await fixture(w => {
    w.getWorksheet('会员储值信息').getCell('D2').value = null;
    w.getWorksheet('会员护理疗程').getCell('E2').value = null;
  }));
  assert.equal(result.issues.filter(i => i.code === 'REQUIRED_VALUE').length, 2);
  assert.equal(result.balances[0].balance, null);
  assert.equal(result.courses[0].remaining, null);
});

test('重复会员、手机号、储值、疗程及孤立关联全部报告', async () => {
  const result = await parseWorkbook(await fixture(w => {
    w.getWorksheet('会员基础信息').addRow(['0001', '', '另一记录', '13800000001']);
    w.getWorksheet('会员储值信息').addRow(['0001', 0, 0, 0]);
    w.getWorksheet('会员护理疗程').addRow(['0001', '深层清洁', 1, 0, 1]);
    w.getWorksheet('会员护理疗程').addRow(['other', '补水', 1, 0, 1]);
  }));
  for (const code of ['DUPLICATE_MEMBER', 'DUPLICATE_PHONE', 'DUPLICATE_BALANCE', 'DUPLICATE_COURSE', 'ORPHAN_RECORD']) assert.ok(has(result, code), code);
});

test('数值编号和掩码手机号阻断，避免丢失前导零或伪造身份', async () => {
  const result = await parseWorkbook(await fixture(w => {
    w.getWorksheet('会员基础信息').getCell('A2').value = 1;
    w.getWorksheet('会员基础信息').getCell('D2').value = '138****0001';
  }));
  assert.ok(result.issues.some(i => i.field === '会员编号' && i.code === 'INVALID_VALUE'));
  assert.ok(result.issues.some(i => i.field === '手机号码' && i.code === 'INVALID_VALUE'));
});

test('公式、外链、损坏文件和超大文件在解析前拒绝', async () => {
  const formula = await parseWorkbook(await fixture(w => { w.getWorksheet('会员储值信息').getCell('D2').value = { formula: 'B2-C2', result: 2500 }; }));
  assert.ok(has(formula, 'INVALID_FILE'));
  assert.match(formula.issues[0].message, /公式/);
  const link = await parseWorkbook(await fixture(w => { w.getWorksheet('会员基础信息').getCell('F2').value = { text: '链接', hyperlink: 'https://example.com' }; }));
  assert.ok(has(link, 'INVALID_FILE'));
  assert.ok(has(await parseWorkbook(Buffer.from('not xlsx')), 'INVALID_FILE'));
  assert.throws(() => inspectXlsxArchive(Buffer.alloc(EXCEL_LIMITS.fileBytes + 1)), /5 MB/);
});

test('假报压缩大小无法绕过实际解压上限', async () => {
  const original = await fixture();
  const altered = Buffer.from(original);
  const central = altered.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  altered.writeUInt32LE(1, central + 24);
  assert.throws(() => inspectXlsxArchive(altered));
});

test('150 会员批次精确汇总、多项目关联和空白格式行处理正确', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createTemplateWorkbook());
  for (let n = 1; n <= 150; n++) {
    const id = `M${String(n).padStart(3, '0')}`;
    workbook.getWorksheet('会员基础信息').addRow([id, '分类标签', `脱敏测试${n}`, `1380000${String(n).padStart(4, '0')}`, null, '']);
    workbook.getWorksheet('会员储值信息').addRow([id, '10.10', '10.00', '0.10', '']);
    workbook.getWorksheet('会员护理疗程').addRow([id, '深层清洁', 10, 6, 4, '']);
    workbook.getWorksheet('会员护理疗程').addRow([id, '补水', 2, 1, 1, '']);
  }
  workbook.getWorksheet('会员基础信息').getRow(400).height = 25;
  const result = await parseWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.deepEqual(result.issues, []);
  assert.equal(result.members.length, 150);
  assert.equal(result.summary.balance, '15.00');
  assert.equal(result.summary.historicalRecharge, '1515.00');
  assert.equal(result.courses.length, 300);
  assert.deepEqual(result.summary.projects.map(p => p.remaining), [600, 150]);
});

test('缺少权益记录仅给待确认警告，不生成虚假账户或疗程', async () => {
  const result = await parseWorkbook(await fixture(w => {
    w.getWorksheet('会员储值信息').spliceRows(2, 1);
    w.getWorksheet('会员护理疗程').spliceRows(2, 1);
  }));
  assert.ok(has(result, 'NO_BALANCE_RECORD'));
  assert.ok(has(result, 'NO_COURSE_RECORD'));
  assert.equal(result.balances.length, 0);
  assert.equal(result.courses.length, 0);
});
