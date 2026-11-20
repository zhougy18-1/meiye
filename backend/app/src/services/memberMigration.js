import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import { generateUniqueId } from '../utils/id.js';
import { parseWorkbook } from './migrationExcel.js';

export class MemberMigrationError extends Error {
  constructor(message, statusCode = 400, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

const d = value => value === null || value === undefined || value === '' ? null : new Decimal(value);
const dateInShopZone = value => value ? new Date(`${value}T00:00:00+08:00`) : null;
const jsonPlain = value => JSON.parse(JSON.stringify(value));

function totals(parsed) {
  const sum = (rows, key) => rows.reduce((acc, row) => row[key] == null ? acc : acc.plus(row[key]), new Decimal(0)).toFixed(2);
  const unknown = (rows, key) => rows.filter(row => row[key] == null).length;
  const projects = {};
  for (const row of parsed.courses) {
    const item = projects[row.project] ||= { records: 0, purchased: 0, used: 0, remaining: 0, unknownPurchased: 0, unknownUsed: 0 };
    item.records += 1;
    if (row.purchased == null) item.unknownPurchased += 1; else item.purchased += row.purchased;
    if (row.used == null) item.unknownUsed += 1; else item.used += row.used;
    item.remaining += row.remaining || 0;
  }
  return {
    memberCount: parsed.members.length,
    balanceRecordCount: parsed.balances.length,
    courseRecordCount: parsed.courses.length,
    historicalRecharge: sum(parsed.balances, 'historicalRecharge'),
    historicalConsumption: sum(parsed.balances, 'historicalConsumption'),
    openingBalance: sum(parsed.balances, 'balance'),
    unknownHistoricalRecharge: unknown(parsed.balances, 'historicalRecharge'),
    unknownHistoricalConsumption: unknown(parsed.balances, 'historicalConsumption'),
    projects,
  };
}

function mappingIssues(parsed, input, existing) {
  const issues = [];
  const cardMappings = input.cardTypeMappings || {};
  for (const balance of parsed.balances) {
    if (d(balance.balance)?.greaterThan(0) && !cardMappings[balance.externalId] && !input.cardTypeId) {
      issues.push({ severity: 'error', code: 'CARD_TYPE_MAPPING_REQUIRED', sheet: '会员储值信息', row: balance.row, field: '当前储值余额（元）', message: '有期初余额的会员必须明确选择会员卡类型' });
    }
  }
  const projects = [...new Set(parsed.courses.map(row => row.project))];
  for (const project of projects) {
    if (!input.projectMappings?.[project]) issues.push({ severity: 'error', code: 'PACKAGE_PLAN_MAPPING_REQUIRED', sheet: '会员护理疗程', row: null, field: '护理项目', message: `护理项目“${project}”尚未映射到系统套餐` });
    else if (typeof input.projectMappings[project] === 'string') issues.push({ severity: 'warning', code: 'CONFIRM_OPENING_NO_EXPIRY', sheet: '会员护理疗程', row: null, field: '护理项目', message: `护理项目“${project}”的期初权益将按长期有效导入，请核实` });
  }
  for (const member of parsed.members) {
    if (existing.externalIds.has(member.externalId)) issues.push({ severity: 'error', code: 'EXTERNAL_ID_EXISTS', sheet: '会员基础信息', row: member.row, field: '会员编号', message: '会员编号已存在于系统中' });
    if (member.phone && existing.phones.has(member.phone)) issues.push({ severity: 'error', code: 'PHONE_EXISTS', sheet: '会员基础信息', row: member.row, field: '手机号码', message: '手机号码已存在于系统中' });
  }
  if (parsed.members.some(member => !member.phone)) issues.push({ severity: 'warning', code: 'CONFIRM_MISSING_PHONE', sheet: '会员基础信息', row: null, field: '手机号码', message: '存在已核实但缺少手机号的会员，将保留为空，不会生成虚假号码' });
  if (parsed.members.some(member => !member.registrationDate)) issues.push({ severity: 'warning', code: 'CONFIRM_UNKNOWN_JOIN_DATE', sheet: '会员基础信息', row: null, field: '入会日期', message: '存在未知入会日期，将保留为空' });
  if (parsed.balances.length < parsed.members.length) issues.push({ severity: 'warning', code: 'CONFIRM_NO_BALANCE_ROWS', sheet: '会员储值信息', row: null, field: '会员编号', message: '部分会员没有储值记录，请确认确实没有待迁移储值权益' });
  const membersWithCourses = new Set(parsed.courses.map(row => row.externalId));
  if (parsed.members.some(member => !membersWithCourses.has(member.externalId))) issues.push({ severity: 'warning', code: 'CONFIRM_NO_COURSE_ROWS', sheet: '会员护理疗程', row: null, field: '会员编号', message: '部分会员没有护理疗程记录，请确认确实没有待迁移疗程权益' });
  return issues;
}

export function createMemberMigrationService(db) {
  return {
    async options() {
      const [cardTypes, plans] = await Promise.all([
        db.cardType.findMany({ where: { status: 'AVAILABLE' }, orderBy: { name: 'asc' } }),
        db.packagePlan.findMany({ where: { active: true }, include: { service: true }, orderBy: { name: 'asc' } }),
      ]);
      return { cardTypes, plans };
    },

    async preview(input, actor) {
      if (!input.fileBase64 || !input.fileName || !input.cutoffAt) throw new MemberMigrationError('请选择文件并填写统一统计截止时间');
      const cutoffAt = new Date(input.cutoffAt);
      if (!Number.isFinite(cutoffAt.getTime())) throw new MemberMigrationError('统计截止时间格式无效');
      let file;
      try { file = Buffer.from(input.fileBase64, 'base64'); } catch { throw new MemberMigrationError('文件内容无效'); }
      if (!file.length || file.length > 5 * 1024 * 1024) throw new MemberMigrationError('Excel 文件必须小于 5MB');
      const parsed = await parseWorkbook(file);
      const externalIds = parsed.members.map(row => row.externalId);
      const phones = parsed.members.map(row => row.phone).filter(Boolean);
      const existingRows = await db.member.findMany({
        where: { OR: [{ externalId: { in: externalIds } }, { phone: { in: phones } }] },
        select: { externalId: true, phone: true },
      });
      const existing = { externalIds: new Set(existingRows.map(row => row.externalId).filter(Boolean)), phones: new Set(existingRows.map(row => row.phone).filter(Boolean)) };
      const mappings = { cardTypeId: input.cardTypeId || null, cardTypeMappings: input.cardTypeMappings || {}, projectMappings: input.projectMappings || {} };
      const issues = [...parsed.issues, ...mappingIssues(parsed, input, existing)];
      const summary = totals(parsed);
      const batch = await db.memberMigrationBatch.create({ data: {
        fileName: String(input.fileName).slice(0, 255), fileHash: crypto.createHash('sha256').update(file).digest('hex'), cutoffAt,
        snapshot: jsonPlain({ members: parsed.members, balances: parsed.balances, courses: parsed.courses }), mappings,
        issues: jsonPlain(issues), previewSummary: summary, createdBy: actor.id, createdByName: actor.username,
      } });
      return { ...batch, snapshot: batch.snapshot, issues, summary, canCommit: !issues.some(issue => issue.severity === 'error') };
    },

    async list() {
      return db.memberMigrationBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 100,
        select: { id: true, fileName: true, fileHash: true, cutoffAt: true, status: true, previewSummary: true, resultSummary: true, createdByName: true, createdAt: true, committedAt: true, rolledBackAt: true } });
    },

    async get(id) {
      const batch = await db.memberMigrationBatch.findUnique({ where: { id } });
      if (!batch) throw new MemberMigrationError('导入批次不存在', 404);
      return { ...batch, summary: batch.resultSummary || batch.previewSummary };
    },

    async commit(id, acknowledgements, actor) {
      const requestedAcks = new Set(acknowledgements || []);
      return db.$transaction(async tx => {
        const batch = await tx.memberMigrationBatch.findUnique({ where: { id } });
        if (!batch) throw new MemberMigrationError('导入批次不存在', 404);
        if (batch.status === 'COMMITTED') return batch;
        if (batch.status !== 'PREVIEW') throw new MemberMigrationError('该批次当前不能提交', 409);
        const issues = batch.issues || [];
        if (issues.some(issue => issue.severity === 'error')) throw new MemberMigrationError('仍有阻断错误，不能正式导入', 409);
        const warningCodes = [...new Set(issues.filter(issue => issue.severity === 'warning').map(issue => issue.code))];
        const missing = warningCodes.filter(code => !requestedAcks.has(code));
        if (missing.length) throw new MemberMigrationError('请先确认全部警告再导入', 409, { missingAcknowledgements: missing });
        const duplicate = await tx.memberMigrationBatch.findFirst({ where: { fileHash: batch.fileHash, status: 'COMMITTED', id: { not: id } } });
        if (duplicate) throw new MemberMigrationError('相同内容的文件已经成功导入', 409);
        const claimed = await tx.memberMigrationBatch.updateMany({ where: { id, status: 'PREVIEW' }, data: { status: 'COMMITTING', acknowledgements: warningCodes } });
        if (claimed.count !== 1) throw new MemberMigrationError('批次正在由其他请求处理', 409);

        const snapshot = batch.snapshot;
        const mappings = batch.mappings;
        const balances = new Map(snapshot.balances.map(row => [row.externalId, row]));
        const memberIds = new Map();
        for (const row of snapshot.members) {
          if (await tx.member.findFirst({ where: { OR: [{ externalId: row.externalId }, ...(row.phone ? [{ phone: row.phone }] : [])] } })) throw new MemberMigrationError(`会员 ${row.externalId} 已存在，批次已停止`, 409);
          const memberId = await generateUniqueId(tx.member);
          const balance = balances.get(row.externalId);
          await tx.member.create({ data: {
            id: memberId, externalId: row.externalId, classification: row.classification || null, name: row.name,
            phone: row.phone || null, registrationDate: dateInShopZone(row.registrationDate), notes: row.notes || null,
            historicalRecharge: balance?.historicalRecharge ?? null, historicalConsumption: balance?.historicalConsumption ?? null,
            openingBalanceNotes: balance?.notes || null,
            importBatchId: id,
          } });
          memberIds.set(row.externalId, memberId);
          if (d(balance?.balance)?.greaterThan(0)) {
            const cardTypeId = mappings.cardTypeMappings?.[row.externalId] || mappings.cardTypeId;
            const cardType = await tx.cardType.findUnique({ where: { id: cardTypeId } });
            if (!cardType || cardType.status !== 'AVAILABLE') throw new MemberMigrationError(`会员 ${row.externalId} 的会员卡类型无效`, 409);
            await tx.card.create({ data: { id: await generateUniqueId(tx.card), memberId, cardTypeId, balance: balance.balance,
              openingBalance: balance.balance, issueDate: batch.cutoffAt, status: 'ACTIVE', importBatchId: id } });
          }
        }
        for (const row of snapshot.courses) {
          const configured = mappings.projectMappings?.[row.project];
          const mapping = typeof configured === 'string' ? { planId: configured, expiresAt: null } : configured;
          const plan = mapping?.planId ? await tx.packagePlan.findUnique({ where: { id: mapping.planId }, include: { service: true } }) : null;
          if (!plan || !plan.active) throw new MemberMigrationError(`护理项目“${row.project}”的套餐映射已失效`, 409);
          const totalUses = Math.max(row.purchased ?? row.remaining, row.remaining);
          await tx.packageHolding.create({ data: {
            memberId: memberIds.get(row.externalId), planId: plan.id, planName: `${plan.name}（期初）`, totalUses,
            remainingUses: row.remaining, paidAmount: '0.00', paymentMethod: 'OTHER', status: row.remaining > 0 ? 'ACTIVE' : 'DEPLETED',
            purchasedAt: batch.cutoffAt, expiresAt: mapping.expiresAt ? new Date(mapping.expiresAt) : null,
            createdBy: actor.id, createdByName: actor.username, requestKey: `opening-${id}-${row.externalId}-${row.row}`,
            source: 'OPENING', importBatchId: id,
            openingRemainingUses: row.remaining,
            openingPurchasedUses: row.purchased ?? null, openingUsedUses: row.used ?? null, openingNotes: row.notes || null,
          } });
        }
        const [createdMembers, createdCards, createdHoldings] = await Promise.all([
          tx.member.findMany({ where: { importBatchId: id }, select: { historicalRecharge: true, historicalConsumption: true } }),
          tx.card.findMany({ where: { importBatchId: id }, select: { balance: true, openingBalance: true } }),
          tx.packageHolding.findMany({ where: { importBatchId: id }, select: { requestKey: true, openingPurchasedUses: true, openingUsedUses: true, openingRemainingUses: true } }),
        ]);
        const sumDecimal = (rows, key) => rows.reduce((sum, row) => row[key] == null ? sum : sum.plus(row[key]), new Decimal(0)).toFixed(2);
        const actualProjects = {};
        const sourceProjectByRequestKey = new Map(snapshot.courses.map(row => [`opening-${id}-${row.externalId}-${row.row}`, row.project]));
        for (const holding of createdHoldings) {
          const name = sourceProjectByRequestKey.get(holding.requestKey) || '无法关联的期初疗程';
          const item = actualProjects[name] ||= { records: 0, purchased: 0, used: 0, remaining: 0, unknownPurchased: 0, unknownUsed: 0 };
          item.records += 1;
          if (holding.openingPurchasedUses == null) item.unknownPurchased += 1; else item.purchased += holding.openingPurchasedUses;
          if (holding.openingUsedUses == null) item.unknownUsed += 1; else item.used += holding.openingUsedUses;
          item.remaining += holding.openingRemainingUses;
        }
        const actual = {
          memberCount: createdMembers.length,
          cardCount: createdCards.length,
          holdingCount: createdHoldings.length,
          historicalRecharge: sumDecimal(createdMembers, 'historicalRecharge'),
          historicalConsumption: sumDecimal(createdMembers, 'historicalConsumption'),
          openingBalance: sumDecimal(createdCards, 'openingBalance'),
          currentBalance: sumDecimal(createdCards, 'balance'),
          projects: actualProjects,
        };
        const expected = batch.previewSummary;
        const reconciliation = {
          memberCount: actual.memberCount - expected.memberCount,
          courseRecordCount: actual.holdingCount - expected.courseRecordCount,
          historicalRecharge: new Decimal(actual.historicalRecharge).minus(expected.historicalRecharge).toFixed(2),
          historicalConsumption: new Decimal(actual.historicalConsumption).minus(expected.historicalConsumption).toFixed(2),
          openingBalance: new Decimal(actual.openingBalance).minus(expected.openingBalance).toFixed(2),
        };
        const projectReconciliation = {};
        for (const project of new Set([...Object.keys(expected.projects || {}), ...Object.keys(actual.projects)])) {
          const expectedProject = expected.projects?.[project] || {};
          const actualProject = actual.projects[project] || {};
          projectReconciliation[project] = Object.fromEntries(['records', 'purchased', 'used', 'remaining', 'unknownPurchased', 'unknownUsed']
            .map(key => [key, (actualProject[key] || 0) - (expectedProject[key] || 0)]));
        }
        const resultSummary = { expected, actual, reconciliation, projectReconciliation,
          reconciled: Object.values(reconciliation).every(value => Number(value) === 0)
            && Object.values(projectReconciliation).every(item => Object.values(item).every(value => value === 0)) };
        if (!resultSummary.reconciled) throw new MemberMigrationError('数据库实存值与预览汇总不一致，已自动取消本次导入', 409, reconciliation);
        return tx.memberMigrationBatch.update({ where: { id }, data: { status: 'COMMITTED', committedAt: new Date(), resultSummary } });
      }, { isolationLevel: 'Serializable', timeout: 30000 });
    },

    async rollback(id, reason, actor) {
      if (!reason?.trim()) throw new MemberMigrationError('请填写回滚原因');
      return db.$transaction(async tx => {
        const batch = await tx.memberMigrationBatch.findUnique({ where: { id } });
        if (!batch) throw new MemberMigrationError('导入批次不存在', 404);
        if (batch.status === 'ROLLED_BACK') return batch;
        if (batch.status !== 'COMMITTED') throw new MemberMigrationError('只有已成功导入的批次可以回滚', 409);
        const claimed = await tx.memberMigrationBatch.updateMany({ where: { id, status: 'COMMITTED' }, data: { status: 'ROLLING_BACK' } });
        if (claimed.count !== 1) throw new MemberMigrationError('批次正在由其他请求处理', 409);
        const members = await tx.member.findMany({ where: { importBatchId: id }, include: { cards: true, packageHoldings: { include: { usages: true, audits: true } }, transactions: true, appointments: true } });
        for (const member of members) {
          if (member.transactions.length || member.appointments.length) throw new MemberMigrationError(`会员 ${member.externalId} 已发生后续交易或预约，不能整批回滚`, 409);
          if (member.cards.some(card => card.importBatchId !== id || !new Decimal(card.balance).equals(card.openingBalance || 0))) throw new MemberMigrationError(`会员 ${member.externalId} 的储值余额已经发生变化，不能整批回滚`, 409);
          if (member.packageHoldings.some(holding => holding.importBatchId !== id || holding.usages.length || holding.audits.length || holding.remainingUses !== holding.openingRemainingUses)) throw new MemberMigrationError(`会员 ${member.externalId} 的疗程权益已经使用或调整，不能整批回滚`, 409);
        }
        await tx.packageHolding.deleteMany({ where: { importBatchId: id } });
        await tx.card.deleteMany({ where: { importBatchId: id } });
        await tx.member.deleteMany({ where: { importBatchId: id } });
        return tx.memberMigrationBatch.update({ where: { id }, data: { status: 'ROLLED_BACK', rolledBackAt: new Date(), rolledBackBy: actor.id, rolledBackByName: actor.username, rollbackReason: reason.trim() } });
      }, { isolationLevel: 'Serializable', timeout: 30000 });
    },
  };
}
