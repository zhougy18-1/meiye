// backend/app/tests/p0-gap/_helpers.js
// QA #6 共享测试基础设施。本文件不是测试用例（不匹配 *.test.js 通配），
// 只被各测试文件 import。约束：
//   - 不引入任何新依赖，只用项目已有依赖 + Node 22 内置模块；
//   - 凭据只从 backend/app/.env 读入本进程环境变量，绝不打印 / 写入文件 / 回显；
//   - 所有 QA 数据统一 `qa-<文件标签>-` 前缀，按外键顺序清理，不触碰演示数据。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '../..');          // backend/app
export const PROJECT_ROOT = path.resolve(APP_ROOT, '../..');  // QingSi

// --- 1) 加载 .env 到本进程（不覆盖系统已有变量；不输出任何值） ---------------
for (const raw of fs.readFileSync(path.join(APP_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 1) continue;
  const key = line.slice(0, i).trim();
  let value = line.slice(i + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (process.env[key] === undefined) process.env[key] = value;
}
// 关闭 Prisma 的 query 日志，避免污染 node:test 的 TAP 输出
process.env.NODE_ENV = 'test';

// --- 2) env 就绪后再动态加载被测实现模块 ------------------------------------
const { default: prisma } = await import('../../src/db/prisma.js');
const jwtNs = await import('jsonwebtoken');
const decimalNs = await import('decimal.js');
const jwt = jwtNs.default || jwtNs;
const Decimal = decimalNs.default || decimalNs;

const pkgSvc = await import('../../src/services/packages.js');
const smsSvc = await import('../../src/services/sms.js');
const balanceUtil = await import('../../src/utils/balance.js');
const capacityUtil = await import('../../src/utils/bookingCapacity.js');
const policyMod = await import('../../src/config/p0GapPolicies.js');
const shopTime = await import('../../src/utils/shopTime.js');

export { prisma, jwt, Decimal };
export const { createPackageService, PackageError } = pkgSvc;
export const {
  queueConsumptionSms, dispatchSmsNotification, processPendingSms,
  getSmsRuntimeConfig, applyReceipt, SmsReceiptError,
} = smsSvc;
export const { atomicDecrementBalance, getMemberBalanceSnapshot, roundToTwoDecimals } = balanceUtil;
export const { computeDailyCapacity, assertNoBedConflict, BedConflictError } = capacityUtil;
export const { P0_GAP_POLICIES, computeRefundCap, buildSlotGrid, isValidSourceChannel } = policyMod;
export const { shopDayRange, shopTodayRange, shopMonthWindow, shopMonthKey } = shopTime;

// --- 3) HTTP 客户端 ---------------------------------------------------------
export const BASE_URL = 'http://127.0.0.1:3000';

// 用与 /api/auth/login 完全同构的 payload 本地签 JWT（现有 jsonwebtoken 依赖）。
// 目的：避开登录 per-route 10/min 限流；真实登录链路在 09 号文件单独验证。
export const ROLES = Object.freeze({
  ADMIN:     Object.freeze({ id: 'qa-actor-admin',     username: 'qa-admin',     role: 'ADMIN' }),
  MANAGER:   Object.freeze({ id: 'qa-actor-manager',   username: 'qa-manager',   role: 'MANAGER' }),
  STYLIST:   Object.freeze({ id: 'qa-actor-stylist',   username: 'qa-stylist',   role: 'STYLIST' }),
  ASSISTANT: Object.freeze({ id: 'qa-actor-assistant', username: 'qa-assistant', role: 'ASSISTANT' }),
});

export function tokenFor(role) {
  const actor = ROLES[role];
  assert.ok(actor, `未知角色: ${role}`);
  return jwt.sign(
    { id: actor.id, username: actor.username, role: actor.role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

export async function api(method, urlPath, { token, body, query, headers = {} } = {}) {
  let url = BASE_URL + urlPath;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text, headers: res.headers };
}
export const get = (p, o) => api('GET', p, o);
export const post = (p, o) => api('POST', p, o);
export const patch = (p, o) => api('PATCH', p, o);

// --- 4) QA 数据命名空间与清理 ------------------------------------------------
export const RUN_TAG = crypto.randomBytes(4).toString('hex');

/** 生成一个符合 ^1[3-9]\d{9}$ 的手机号（用于公开预约/短信台账）。 */
export function qaPhone() {
  return `139${String(crypto.randomInt(0, 100000000)).padStart(8, '0')}`;
}

/** 每个测试文件一个独立命名空间，避免并发文件互相删除数据。 */
export function createScope(fileTag) {
  const prefix = `qa-${fileTag}-`;
  let seq = 0;
  const key = (label = 'k') => `${prefix}${label}-${RUN_TAG}-${++seq}`;
  return {
    prefix,
    key,
    qaPhone,
    async cleanup() { await cleanupByPrefix(prefix); },
  };
}

/**
 * 按外键顺序删除某一前缀下的全部 QA 数据。
 * 顺序依据 prisma/schema.prisma：SmsNotification.transaction / PackageUsage.holding /
 * PackageRefundAudit.holding / PackageHolding.member+plan 均为 onDelete: Restrict。
 */
export async function cleanupByPrefix(prefix) {
  const members = await prisma.member.findMany({
    where: { id: { startsWith: prefix } }, select: { id: true },
  });
  const memberIds = members.map(r => r.id);

  const holdings = await prisma.packageHolding.findMany({
    where: { requestKey: { startsWith: prefix } }, select: { id: true },
  });
  const holdingIds = holdings.map(r => r.id);

  const txs = await prisma.transaction.findMany({
    where: { OR: [
      { customerName: { startsWith: prefix } },
      { memberId: { in: memberIds } },
    ] },
    select: { id: true },
  });
  const txIds = txs.map(r => r.id);

  const appts = await prisma.appointment.findMany({
    where: { OR: [
      { customerName: { startsWith: prefix } },
      { customerPhone: { startsWith: prefix } },
      { memberId: { in: memberIds } },
    ] },
    select: { id: true },
  });
  const apptIds = appts.map(r => r.id);

  // 1) 引用 Transaction 的子表
  await prisma.smsNotification.deleteMany({ where: { OR: [
    { transactionId: { in: txIds } }, { memberId: { in: memberIds } },
  ] } });
  await prisma.voidLog.deleteMany({ where: { OR: [
    { originalTxId: { in: txIds } }, { memberId: { in: memberIds } },
  ] } });
  await prisma.transactionItem.deleteMany({ where: { OR: [
    { transactionId: { in: txIds } }, { id: { startsWith: prefix } },
  ] } });
  await prisma.transactionCardLink.deleteMany({ where: { transactionId: { in: txIds } } });
  // 2) Appointment（隐式多对多 join 由 Prisma 自动清理）
  if (apptIds.length) await prisma.appointment.deleteMany({ where: { id: { in: apptIds } } });
  // 3) Transaction 本体
  await prisma.transaction.deleteMany({ where: { id: { in: txIds } } });
  // 4) 套餐子表 → 持有记录
  await prisma.packageUsage.deleteMany({ where: { OR: [
    { requestKey: { startsWith: prefix } }, { holdingId: { in: holdingIds } },
  ] } });
  await prisma.packageRefundAudit.deleteMany({ where: { OR: [
    { requestKey: { startsWith: prefix } }, { holdingId: { in: holdingIds } },
  ] } });
  await prisma.packageHolding.deleteMany({ where: { id: { in: holdingIds } } });
  // 5) Card → Member → 自建 Plan / Service
  await prisma.card.deleteMany({ where: { OR: [
    { memberId: { in: memberIds } }, { id: { startsWith: prefix } },
  ] } });
  await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
  await prisma.packagePlan.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.service.deleteMany({ where: { id: { startsWith: prefix } } });
}

/** 全量清理（仅在 09 号收尾文件调用）。 */
export async function cleanupAllQa() { await cleanupByPrefix('qa-'); }

// --- 5) 演示数据零污染基线 ---------------------------------------------------
// 取值来源：主理人基线 + 工程师《变更与验收清单》§2.3 + QA 实测 2026-11-11。
export const EXPECTED_BASELINE = Object.freeze({
  members: 3, plans: 1, holdings: 2, usages: 3, audits: 0,
  transactions: 4, sms: 2, appointments: 0, cards: 1, voidLogs: 0,
  services: 3, cardTypes: 1, staff: 1, users: 4,
});

export const DEMO = Object.freeze({
  memberIds: Object.freeze(['m7700001', 'm7700002', 'm7700003']),
  holdingIds: Object.freeze(['demo-holding-001', 'demo-holding-002']),
  usageKeys: Object.freeze(['demo-redeem-0001', 'demo-redeem-0002', 'demo-redeem-0003']),
  txIds: Object.freeze(['eupsalyb', 'ibp79o05', 'pv27g544', 'qf2zal8z']),
  planId: 'demo-plan-001',
  serviceId: 'svc00001',
  service2Id: 'svc00002',
  cardTypeId: 'cardtype-demo-001',
  staffId: 'staff001',
});

export async function captureCounts() {
  const models = {
    members: prisma.member, plans: prisma.packagePlan, holdings: prisma.packageHolding,
    usages: prisma.packageUsage, audits: prisma.packageRefundAudit,
    transactions: prisma.transaction, sms: prisma.smsNotification,
    appointments: prisma.appointment, cards: prisma.card, voidLogs: prisma.voidLog,
    services: prisma.service, cardTypes: prisma.cardType, staff: prisma.staff, users: prisma.user,
  };
  const entries = await Promise.all(
    Object.entries(models).map(async ([k, m]) => [k, await m.count()]),
  );
  return Object.fromEntries(entries);
}

const plain = rows => JSON.parse(JSON.stringify(rows));

/** 在模块加载期（任何测试写入之前）抓取演示行快照。 */
export const BASELINE_DEMO = plain(await (async () => {
  const [holdings, usages, txs, sms, members, config] = await Promise.all([
    prisma.packageHolding.findMany({ where: { id: { in: DEMO.holdingIds } }, orderBy: { id: 'asc' } }),
    prisma.packageUsage.findMany({ where: { requestKey: { in: DEMO.usageKeys } }, orderBy: { requestKey: 'asc' } }),
    prisma.transaction.findMany({ where: { id: { in: DEMO.txIds } }, orderBy: { id: 'asc' } }),
    prisma.smsNotification.findMany({ where: { transactionId: { in: DEMO.txIds } }, orderBy: { id: 'asc' } }),
    prisma.member.findMany({ where: { id: { in: DEMO.memberIds } }, orderBy: { id: 'asc' } }),
    prisma.systemConfig.findUnique({ where: { id: 1 } }),
  ]);
  return { holdings, usages, txs, sms, members, config };
})());

/** 断言：条数 + 演示行逐字段均未变化、SystemConfig 已还原。 */
export async function assertDemoDataIntact() {
  const counts = await captureCounts();
  assert.deepEqual(counts, EXPECTED_BASELINE, '演示数据条数必须与基线完全一致（零污染）');

  const [holdings, usages, txs, sms, members, config] = await Promise.all([
    prisma.packageHolding.findMany({ where: { id: { in: DEMO.holdingIds } }, orderBy: { id: 'asc' } }),
    prisma.packageUsage.findMany({ where: { requestKey: { in: DEMO.usageKeys } }, orderBy: { requestKey: 'asc' } }),
    prisma.transaction.findMany({ where: { id: { in: DEMO.txIds } }, orderBy: { id: 'asc' } }),
    prisma.smsNotification.findMany({ where: { transactionId: { in: DEMO.txIds } }, orderBy: { id: 'asc' } }),
    prisma.member.findMany({ where: { id: { in: DEMO.memberIds } }, orderBy: { id: 'asc' } }),
    prisma.systemConfig.findUnique({ where: { id: 1 } }),
  ]);
  const now = plain({ holdings, usages, txs, sms, members, config });
  assert.deepEqual(now, BASELINE_DEMO, '演示行内容或 SystemConfig 被改动（零污染失败）');
}

// --- 6) SystemConfig 临时改动 / 还原（bookingCode、交易撤销开关） -----------
export async function snapshotConfig() {
  const c = await prisma.systemConfig.findUnique({ where: { id: 1 } });
  return {
    enableLoginCaptcha: c.enableLoginCaptcha,
    enableTransactionVoid: c.enableTransactionVoid,
    voidEnabledAt: c.voidEnabledAt,
    bookingCode: c.bookingCode,
    bookingCodeUpdatedAt: c.bookingCodeUpdatedAt,
  };
}
export async function restoreConfig(snap) {
  await prisma.systemConfig.update({ where: { id: 1 }, data: snap });
}

// --- 7) 小工具 ---------------------------------------------------------------
export async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

export function dec(value) { return new Decimal(value == null ? 0 : value.toString()); }
