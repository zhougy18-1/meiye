import ExcelJS from 'exceljs';
import Decimal from 'decimal.js';
import { inflateRawSync } from 'node:zlib';

export const TEMPLATE_VERSION = 'M77-2026-11-20.1';
export const EXCEL_LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, expandedBytes: 20 * 1024 * 1024, entryBytes: 8 * 1024 * 1024, entries: 200, rows: 2000, columns: 32 });
export const MIGRATION_SHEETS = Object.freeze({
  members: { name: '会员基础信息', fields: ['externalId', 'classification', 'name', 'phone', 'registrationDate', 'notes'], headers: ['会员编号', '会员等级', '姓名', '手机号码', '入会日期', '备注'] },
  balances: { name: '会员储值信息', fields: ['externalId', 'historicalRecharge', 'historicalConsumption', 'balance', 'notes'], headers: ['会员编号', '历史累计充值（元）', '历史累计消费（元）', '当前储值余额（元）', '备注'] },
  courses: { name: '会员护理疗程', fields: ['externalId', 'project', 'purchased', 'used', 'remaining', 'notes'], headers: ['会员编号', '护理项目', '购买次数', '已用次数', '剩余次数', '备注'] },
});

// Check central and local ZIP records before ExcelJS allocates workbook objects.
// Actual inflation is bounded too: trusting advertised sizes alone allows ZIP bombs.
export function inspectXlsxArchive(input) {
  const data = Buffer.from(input);
  if (!data.length || data.length > EXCEL_LIMITS.fileBytes) throw new Error('文件为空或超过 5 MB 限制');
  if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) throw new Error('请上传有效的 .xlsx 工作簿');
  let end = -1;
  for (let p = data.length - 22; p >= Math.max(0, data.length - 65557); p--) {
    if (data.readUInt32LE(p) === 0x06054b50 && p + 22 + data.readUInt16LE(p + 20) === data.length) { end = p; break; }
  }
  if (end < 0) throw new Error('工作簿压缩结构损坏');
  const count = data.readUInt16LE(end + 10);
  const dirSize = data.readUInt32LE(end + 12);
  let offset = data.readUInt32LE(end + 16);
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== count || count > EXCEL_LIMITS.entries || count === 0 || offset + dirSize !== end) throw new Error('不支持分卷、ZIP64 或过大的工作簿');
  let expanded = 0;
  const names = new Set();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) throw new Error('工作簿目录损坏');
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || ![0, 8].includes(method) || (flags & 1) || size > EXCEL_LIMITS.entryBytes || compressed > data.length || local + 30 > end) throw new Error('不支持加密或过大的工作簿内容');
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!name || names.has(name) || name.includes('..') || name.includes('\\') || name.startsWith('/') || name.includes('\0')) throw new Error('工作簿包含异常文件路径');
    names.add(name);
    if (/vbaProject|externalLinks\/|embeddings\//i.test(name)) throw new Error('工作簿不得包含宏、外部链接或嵌入文件');
    expanded += size;
    if (expanded > EXCEL_LIMITS.expandedBytes) throw new Error('工作簿解压后超过 20 MB 限制');
    if (data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 8) !== method || data.readUInt16LE(local + 6) !== flags) throw new Error('工作簿文件头不一致');
    const localNameLength = data.readUInt16LE(local + 26);
    const start = local + 30 + localNameLength + data.readUInt16LE(local + 28);
    if (start + compressed > data.readUInt32LE(end + 16) || data.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name) throw new Error('工作簿文件边界损坏');
    const packed = data.subarray(start, start + compressed);
    const plain = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.min(EXCEL_LIMITS.entryBytes, size + 1) });
    if (plain.length !== size) throw new Error('工作簿文件大小不一致');
    if (/\.xml$|\.rels$/i.test(name)) {
      const xml = plain.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('工作簿不得包含外部 XML 实体');
      if (/macroEnabled|vbaProject|TargetMode\s*=\s*["']External["']/i.test(xml)) throw new Error('工作簿不得包含宏或外部链接');
      if (/^xl\/worksheets\/.*\.xml$/.test(name)) {
        if (/<(?:\w+:)?f(?:\s|>)/.test(xml)) throw new Error('数据中含公式，请转换为已核实的值后重新上传');
        if (/<(?:\w+:)?mergeCell(?:\s|>)/.test(xml)) throw new Error('导入模板不支持合并单元格，请取消合并后重新上传');
        for (const match of xml.matchAll(/<(?:\w+:)?(?:row|c)\s[^>]*\br=["']([A-Z]*)(\d+)["']/g)) {
          const col = [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
          if (Number(match[2]) > EXCEL_LIMITS.rows + 1 || col > EXCEL_LIMITS.columns) throw new Error('工作簿超过 2000 行或 32 列限制');
        }
      }
    }
    offset = next;
  }
  if (offset !== end || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw new Error('不是有效的 Excel 工作簿');
}

const blank = value => value === null || value === undefined || (typeof value === 'string' && !value.trim());
function textValue(value) {
  if (blank(value)) return null;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('').trim() || null;
  throw new Error('请填写普通文本或数值，不要使用公式、错误值或链接');
}

export function parseMoney(value) {
  if (blank(value)) return null;
  const str = textValue(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(str) || str.length > 24) throw new Error('金额须为非负数字，最多两位小数');
  const number = new Decimal(str);
  if (number.gt('99999999.99')) throw new Error('金额超过支持范围 99999999.99 元');
  return number.toFixed(2);
}

export function parseCount(value) {
  if (blank(value)) return null;
  const str = textValue(value);
  if (!/^\d+$/.test(str) || !Number.isSafeInteger(Number(str)) || Number(str) > 2147483647) throw new Error('次数须为 0 至 2147483647 的整数');
  return Number(str);
}

export function parseDate(value, date1904 = false) {
  if (blank(value)) return null;
  let date;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('无效日期');
    date = value.toISOString().slice(0, 10);
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || (!date1904 && value === 60) || value > 2958465) throw new Error('无效 Excel 日期，请使用 YYYY-MM-DD');
    const offset = date1904 ? 24107 : value < 60 ? 25568 : 25569;
    date = new Date((value - offset) * 86400000).toISOString().slice(0, 10);
  } else date = textValue(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date < '1900-01-01') throw new Error('日期须为有效的 YYYY-MM-DD 格式');
  return date;
}

export function summarizeMigration({ members, balances, courses }) {
  const sumMoney = key => balances.reduce((sum, row) => sum.plus(row[key] ?? 0), new Decimal(0)).toFixed(2);
  const projects = new Map();
  for (const row of courses) {
    const item = projects.get(row.project) || { project: row.project, records: 0, purchased: 0, used: 0, remaining: 0, unknownPurchased: 0, unknownUsed: 0 };
    item.records++;
    for (const key of ['purchased', 'used', 'remaining']) item[key] += row[key] ?? 0;
    if (row.purchased === null) item.unknownPurchased++;
    if (row.used === null) item.unknownUsed++;
    projects.set(row.project, item);
  }
  return { members: members.length, balances: balances.length, courses: courses.length, historicalRecharge: sumMoney('historicalRecharge'), historicalConsumption: sumMoney('historicalConsumption'), balance: sumMoney('balance'), unknownRecharge: balances.filter(row => row.historicalRecharge === null).length, unknownConsumption: balances.filter(row => row.historicalConsumption === null).length, projects: [...projects.values()] };
}

export async function parseWorkbook(buffer) {
  const result = { members: [], balances: [], courses: [], issues: [] };
  const add = (severity, code, sheet, row, field, message) => result.issues.push({ severity, code, sheet, row, field, message });
  try { inspectXlsxArchive(buffer); }
  catch (error) { add('error', 'INVALID_FILE', '', 0, '', error.message.startsWith('Cannot') || error.code ? '工作簿损坏或内容超出安全限制' : error.message); return { ...result, summary: summarizeMigration(result) }; }
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch { add('error', 'INVALID_FILE', '', 0, '', '无法读取工作簿，请重新保存为 .xlsx'); return { ...result, summary: summarizeMigration(result) }; }
  for (const sheet of workbook.worksheets) {
    if (![...Object.values(MIGRATION_SHEETS).map(s => s.name), '填写说明'].includes(sheet.name)) add('error', 'UNKNOWN_SHEET', sheet.name, 0, '', '存在未识别工作表，请使用正式模板');
  }
  if (!workbook.getWorksheet('填写说明')) add('error', 'MISSING_SHEET', '填写说明', 0, '', '缺少填写说明工作表，请使用完整正式模板');
  for (const [key, spec] of Object.entries(MIGRATION_SHEETS)) {
    const sheet = workbook.getWorksheet(spec.name);
    if (!sheet) { add('error', 'MISSING_SHEET', spec.name, 0, '', '缺少必要数据工作表'); continue; }
    const columns = new Map();
    sheet.getRow(1).eachCell((cell, col) => {
      let title;
      try { title = textValue(cell.value); } catch { title = null; }
      if (!title) return;
      if (columns.has(title)) add('error', 'DUPLICATE_HEADER', spec.name, 1, title, '表头重复');
      columns.set(title, col);
      if (!spec.headers.includes(title)) add('error', 'UNKNOWN_HEADER', spec.name, 1, title, '未知字段，不能静默忽略');
    });
    for (const title of spec.headers) if (!columns.has(title)) add('error', 'MISSING_HEADER', spec.name, 1, title, '缺少必要字段');
    if (spec.headers.some(title => !columns.has(title))) continue;
    sheet.eachRow((excelRow, row) => {
      if (row === 1 || !excelRow.values.some(value => !blank(value))) return;
      const item = { row };
      excelRow.eachCell((cell, col) => {
        if (![...columns.values()].includes(col) && !blank(cell.value)) add('error', 'UNNAMED_COLUMN', spec.name, row, `第 ${col} 列`, '无表头列中存在数据');
      });
      spec.fields.forEach((field, index) => {
        const title = spec.headers[index];
        const value = excelRow.getCell(columns.get(title)).value;
        try {
          item[field] = ['historicalRecharge', 'historicalConsumption', 'balance'].includes(field) ? parseMoney(value)
            : ['purchased', 'used', 'remaining'].includes(field) ? parseCount(value)
              : field === 'registrationDate' ? parseDate(value, workbook.properties.date1904) : textValue(value);
          if (typeof item[field] === 'string' && item[field].length > (field === 'notes' ? 2000 : 191)) throw new Error(field === 'notes' ? '备注不能超过 2000 字' : '字段不能超过 191 字');
          if (field === 'externalId' && typeof value === 'number') throw new Error('会员编号须以文本填写，以保留前导零');
          if (field === 'phone' && item.phone && !/^1\d{10}$/.test(item.phone)) throw new Error('请填写完整有效的 11 位手机号，不能使用掩码或占位号码');
        } catch (error) { item[field] = null; add('error', 'INVALID_VALUE', spec.name, row, title, error.message); }
      });
      for (const field of key === 'members' ? ['externalId', 'name'] : key === 'balances' ? ['externalId', 'balance'] : ['externalId', 'project', 'remaining']) {
        if (item[field] === null) add('error', 'REQUIRED_VALUE', spec.name, row, spec.headers[spec.fields.indexOf(field)], '该项必须核实填写，未知不能按 0 导入');
      }
      result[key].push(item);
    });
  }
  const members = new Map();
  const phones = new Set();
  for (const member of result.members) {
    if (member.externalId && members.has(member.externalId)) add('error', 'DUPLICATE_MEMBER', MIGRATION_SHEETS.members.name, member.row, '会员编号', '会员编号在基础信息中重复');
    members.set(member.externalId, member);
    if (member.phone && phones.has(member.phone)) add('error', 'DUPLICATE_PHONE', MIGRATION_SHEETS.members.name, member.row, '手机号码', '同一手机号对应多条会员记录，请核实');
    if (member.phone) phones.add(member.phone);
    else add('warning', 'MISSING_PHONE', MIGRATION_SHEETS.members.name, member.row, '手机号码', '手机号缺失，须确认保留空值，不会填入虚假号码');
  }
  const balanceIds = new Set();
  const courseIds = new Set();
  const courseKeys = new Set();
  for (const [key, records] of [['balances', result.balances], ['courses', result.courses]]) {
    const sheet = MIGRATION_SHEETS[key].name;
    for (const row of records) {
      if (!members.has(row.externalId)) add('error', 'ORPHAN_RECORD', sheet, row.row, '会员编号', '未找到本批次基础信息中的对应会员');
      if (key === 'balances') {
        if (balanceIds.has(row.externalId)) add('error', 'DUPLICATE_BALANCE', sheet, row.row, '会员编号', '同一会员只能有一条储值汇总，不能自动相加');
        balanceIds.add(row.externalId);
        if (row.historicalRecharge === null || row.historicalConsumption === null) add('warning', 'UNKNOWN_HISTORY', sheet, row.row, '历史统计', '历史充值或消费未知，将保留未知状态');
        if (row.historicalRecharge !== null && row.historicalConsumption !== null && row.balance !== null && !new Decimal(row.historicalRecharge).minus(row.historicalConsumption).eq(row.balance)) add('warning', 'BALANCE_DIFFERENCE', sheet, row.row, '当前储值余额（元）', '充值减消费与余额不同；请核实赠送、退款或调整并说明，系统以确认余额建账');
      } else {
        courseIds.add(row.externalId);
        const identity = JSON.stringify([row.externalId, row.project]);
        if (courseKeys.has(identity)) add('error', 'DUPLICATE_COURSE', sheet, row.row, '护理项目', '同一会员同一项目重复，需先核实，不能自动合并');
        courseKeys.add(identity);
        if (row.purchased !== null && row.used !== null && row.remaining !== null && row.purchased - row.used !== row.remaining) add('warning', 'COURSE_DIFFERENCE', sheet, row.row, '剩余次数', '购买减已用与剩余不同；请核实赠送或调整并说明，系统以确认剩余次数建账');
      }
    }
  }
  for (const member of result.members) {
    if (!balanceIds.has(member.externalId)) add('warning', 'NO_BALANCE_RECORD', MIGRATION_SHEETS.members.name, member.row, '会员编号', '该会员没有储值记录，须确认没有待迁移储值权益');
    if (!courseIds.has(member.externalId)) add('warning', 'NO_COURSE_RECORD', MIGRATION_SHEETS.members.name, member.row, '会员编号', '该会员没有疗程记录，须确认没有待迁移疗程权益');
  }
  if (!result.members.length) add('error', 'EMPTY_WORKBOOK', MIGRATION_SHEETS.members.name, 0, '', '暂无可导入会员数据；说明页示例不参与导入');
  return { ...result, summary: summarizeMigration(result) };
}

export async function createTemplateWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '青丝店务系统';
  workbook.title = `M.77美肤空间会员资料导入模板 ${TEMPLATE_VERSION}`;
  for (const spec of Object.values(MIGRATION_SHEETS)) {
    const sheet = workbook.addWorksheet(spec.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = spec.headers.map((header, index) => ({ header, key: spec.fields[index], width: header === '备注' ? 38 : header.includes('（元）') ? 25 : 19 }));
    for (const column of sheet.columns) {
      column.numFmt = ['historicalRecharge', 'historicalConsumption', 'balance'].includes(column.key) ? '0.00' : ['purchased', 'used', 'remaining'].includes(column.key) ? '0' : '@';
    }
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: spec.headers.length } };
    styleHeader(sheet);
  }
  const instructions = workbook.addWorksheet('填写说明');
  instructions.columns = [{ header: '项目', key: 'item', width: 23 }, { header: '填写要求', key: 'requirement', width: 90 }, { header: '示例', key: 'example', width: 30 }];
  instructions.addRows([
    ['适用门店', 'M.77美肤空间｜青丝店务系统首次会员历史数据迁移', TEMPLATE_VERSION],
    ['会员编号', '三张表使用相同的唯一文本编号；基础信息一人一行；保留前导零。', 'M001'],
    ['会员等级', '仅为会员分类标签，不自动产生折扣、赠送或任何权益；可空。', '按门店实际分类填写'],
    ['姓名 / 手机号码', '姓名必填；手机号按文本填完整号码；未知可空但须在导入时核实确认。重复或掩码号码不能直接导入。', '示例不属于正式会员数据'],
    ['入会日期', '填写真实日期 YYYY-MM-DD，不清楚留空，不用导入日期替代。', '2025-03-01'],
    ['历史累计充值 / 消费', '历史汇总，不作为导入日新收入；未知留空，确认没有才填 0。金额最多两位小数。', '10000.00 / 7500.00'],
    ['当前储值余额', '填写核实后的实际可用余额；存在储值行时必填，不自动用充值减消费替代。', '2500.00'],
    ['余额特殊情况', '赠送、退款或调整在备注说明；不自动从备注提取金额。导入界面选择对应的储值卡类型。', '赠送余额含在确认余额中'],
    ['护理项目', '每个会员每个项目一行；导入界面明确关联现有疗程方案，不自动猜测项目。', '深层清洁'],
    ['购买 / 已用 / 剩余次数', '非负整数；购买和已用未知可空；剩余次数必填，确认无剩余填 0；不自动推算覆盖。', '10 / 6 / 4'],
    ['无权益记录', '会员未填写储值或疗程行时，导入预览需明确确认其没有相应待迁移权益。', '不能把遗漏直接当作 0'],
    ['统计截止时间', '在导入界面填写统一截止时间，正式导入前对齐截止后的充值、消费、退款和核销。', 'Asia/Shanghai'],
    ['正式导入', '前三张表为空数据区；本页示例不参与导入。不要删除、重命名或增加字段；不要使用公式和外部链接。', '先预览校验，再确认导入'],
    ['隐私保护', '仅授权老板账号处理真实资料，测试使用脱敏数据；所有异常先核实。', '禁止上传不必要的第三方服务'],
  ]);
  instructions.eachRow(row => { row.alignment = { vertical: 'middle', wrapText: true }; row.height = 45; });
  styleHeader(instructions);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const reportText = value => {
  const text = value == null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
};

export async function createMigrationReportWorkbook(batch) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '青丝店务系统';
  workbook.title = `M.77会员迁移对账报告-${batch.id}`;
  const overview = workbook.addWorksheet('批次对账');
  overview.columns = [{ header: '项目', key: 'item', width: 28 }, { header: '预览值', key: 'expected', width: 24 }, { header: '数据库实存值', key: 'actual', width: 24 }, { header: '差异', key: 'difference', width: 18 }];
  const result = batch.resultSummary || {};
  const expected = result.expected || batch.previewSummary || {};
  const actual = result.actual || {};
  const difference = result.reconciliation || {};
  overview.addRows([
    ['批次编号', reportText(batch.id), '', ''],
    ['文件名', reportText(batch.fileName), '', ''],
    ['文件 SHA-256', reportText(batch.fileHash), '', ''],
    ['统计截止时间', batch.cutoffAt ? new Date(batch.cutoffAt).toISOString() : '', '', ''],
    ['批次状态', batch.status, '', ''],
    ['操作人', reportText(batch.createdByName), '', ''],
    ['会员人数', expected.memberCount ?? '', actual.memberCount ?? '', difference.memberCount ?? ''],
    ['历史累计充值（元）', expected.historicalRecharge ?? '', actual.historicalRecharge ?? '', difference.historicalRecharge ?? ''],
    ['历史累计消费（元）', expected.historicalConsumption ?? '', actual.historicalConsumption ?? '', difference.historicalConsumption ?? ''],
    ['期初储值余额（元）', expected.openingBalance ?? '', actual.openingBalance ?? '', difference.openingBalance ?? ''],
    ['疗程记录数', expected.courseRecordCount ?? '', actual.holdingCount ?? '', difference.courseRecordCount ?? ''],
    ['自动对账结论', result.reconciled === true ? '一致' : result.reconciled === false ? '不一致' : '尚未正式导入', '', ''],
  ]);
  styleHeader(overview);

  const issues = workbook.addWorksheet('异常与确认项');
  issues.columns = [
    { header: '级别', key: 'severity', width: 12 }, { header: '代码', key: 'code', width: 30 },
    { header: '工作表', key: 'sheet', width: 20 }, { header: '行号', key: 'row', width: 10 },
    { header: '字段', key: 'field', width: 24 }, { header: '原因及处理建议', key: 'message', width: 70 },
    { header: '已确认', key: 'acknowledged', width: 12 },
  ];
  const acknowledgements = new Set(batch.acknowledgements || []);
  issues.addRows((batch.issues || []).map(issue => ({
    severity: issue.severity === 'error' ? '错误' : '警告', code: reportText(issue.code), sheet: reportText(issue.sheet),
    row: issue.row || '', field: reportText(issue.field), message: reportText(issue.message),
    acknowledged: issue.severity === 'warning' ? (acknowledgements.has(issue.code) ? '是' : '否') : '',
  })));
  styleHeader(issues);
  issues.eachRow((row, index) => { if (index > 1) row.alignment = { vertical: 'top', wrapText: true }; });

  const projects = workbook.addWorksheet('疗程汇总');
  projects.columns = [
    { header: '原文件护理项目', key: 'project', width: 28 }, { header: '预览记录数', key: 'records', width: 14 }, { header: '实存记录数', key: 'actualRecords', width: 14 }, { header: '记录差异', key: 'recordDifference', width: 12 },
    { header: '预览购买次数', key: 'purchased', width: 16 }, { header: '实存购买次数', key: 'actualPurchased', width: 16 }, { header: '购买差异', key: 'purchasedDifference', width: 12 },
    { header: '预览已用次数', key: 'used', width: 16 }, { header: '实存已用次数', key: 'actualUsed', width: 16 }, { header: '已用差异', key: 'usedDifference', width: 12 },
    { header: '预览剩余次数', key: 'remaining', width: 16 }, { header: '实存剩余次数', key: 'actualRemaining', width: 16 }, { header: '剩余差异', key: 'remainingDifference', width: 12 },
    { header: '映射方案ID', key: 'mapped', width: 36 },
  ];
  for (const [project, summary] of Object.entries(expected.projects || {})) {
    const configured = batch.mappings?.projectMappings?.[project];
    const actualProject = actual.projects?.[project] || {};
    const projectDifference = result.projectReconciliation?.[project] || {};
    projects.addRow({ project: reportText(project), ...summary,
      actualRecords: actualProject.records ?? '', recordDifference: projectDifference.records ?? '',
      actualPurchased: actualProject.purchased ?? '', purchasedDifference: projectDifference.purchased ?? '',
      actualUsed: actualProject.used ?? '', usedDifference: projectDifference.used ?? '',
      actualRemaining: actualProject.remaining ?? '', remainingDifference: projectDifference.remaining ?? '',
      mapped: reportText(typeof configured === 'string' ? configured : configured?.planId) });
  }
  styleHeader(projects);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function styleHeader(sheet) {
  const header = sheet.getRow(1);
  header.height = 30;
  header.font = { name: 'Arial', bold: true, color: { argb: 'FF302D28' }, size: 11 };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE3CD' } };
  header.alignment = { vertical: 'middle', wrapText: true };
}

export const createTemplate = createTemplateWorkbook;
