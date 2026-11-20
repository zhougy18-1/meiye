import Decimal from 'decimal.js';
import prisma from '../db/prisma.js';
import { P0_GAP_POLICIES } from '../config/p0GapPolicies.js';

const MAINLAND_PHONE = /^1[3-9]\d{9}$/;
const MAX_ATTEMPTS = 3;

function providerName() {
  return String(process.env.SMS_PROVIDER || 'disabled').trim().toLowerCase();
}

function enabled() {
  return process.env.SMS_ENABLED === 'true' && providerName() !== 'disabled';
}

function tencentConfigured() {
  return [
    'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY', 'TENCENT_SMS_SDK_APP_ID',
    'TENCENT_SMS_SIGN_NAME', 'TENCENT_SMS_TEMPLATE_ID',
  ].every(key => Boolean(process.env[key]?.trim()));
}

function formatShopTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value)).replace('/', '-');
}

function safeError(error) {
  return String(error?.message || error || '短信发送失败').slice(0, 500);
}

export function getSmsRuntimeConfig() {
  const provider = providerName();
  return {
    enabled: enabled(),
    provider,
    configured: provider === 'mock' || (provider === 'tencent' && tencentConfigured()),
    isSimulation: provider === 'mock',
    templatePreview: '您于{time}消费{amount}元，账户余额{balance}元。如非本人操作请联系M.77美肤空间门店。',
    templatePreviews: {
      consume: '您于{time}消费{amount}元，账户余额{balance}元。如非本人操作请联系M.77美肤空间门店。',
      recharge: '您于{time}充值{amount}元，当前会员卡余额{balance}元。',
      pending: '您于{time}挂账{amount}元，当前会员卡余额{balance}元，请尽快到店结清。',
    },
    consentRequired: true,
    // 依赖待决 Q-12：回执回调端点只读开关（默认关闭），便于 AC-06 核验；不暴露任何密钥。
    receiptCallbackEnabled: P0_GAP_POLICIES.SMS_RECEIPT_CALLBACK_ENABLED,
  };
}

// 与收银流水在同一数据库事务内生成 outbox，确保不会出现"收银成功但通知记录丢失"。
// 支持三类交易短信：消费(NORMAL)、充值/办卡(CARD_PURCHASE)、挂账(PENDING)。
export async function queueTransactionSms(db, transaction) {
  if (!enabled() || !transaction.memberId) return null;

  const member = await db.member.findUnique({
    where: { id: transaction.memberId },
    select: { id: true, phone: true, smsNotificationEnabled: true },
  });
  if (!member?.smsNotificationEnabled) return null;

  const balance = await db.card.aggregate({
    where: { memberId: member.id, status: 'ACTIVE' },
    _sum: { balance: true },
  });
  const category = transactionTypeCategory(transaction.transactionType);
  const amount = new Decimal(transaction.actualPaidAmount).abs().toFixed(2);
  const balanceAfter = new Decimal(balance._sum.balance?.toString() || 0).toFixed(2);
  const occurredAt = transaction.transactionTime || new Date();
  const time = formatShopTime(occurredAt);
  const validPhone = MAINLAND_PHONE.test(member.phone);
  const params = { time, amount, balance: balanceAfter };
  const data = {
    transactionId: transaction.id,
    memberId: member.id,
    phoneLast4: (member.phone || '').slice(-4).padStart(4, '*'),
    status: validPhone ? 'PENDING' : 'SKIPPED',
    provider: providerName(),
    amount,
    balanceAfter,
    occurredAt,
    messagePreview: buildMessage(category, time, amount, balanceAfter),
    templateParams: params,
    errorMessage: validPhone ? null : '会员手机号格式无效，未创建发送任务',
  };

  try {
    return await db.smsNotification.create({ data });
  } catch (error) {
    if (error.code !== 'P2002') throw error;
    return db.smsNotification.findUnique({ where: { transactionId: transaction.id } });
  }
}

function transactionTypeCategory(type) {
  if (type === 'CARD_PURCHASE') return 'recharge';
  if (type === 'PENDING') return 'pending';
  return 'consume';
}

function buildMessage(category, time, amount, balanceAfter) {
  if (category === 'recharge') {
    return `您于${time}充值${amount}元，当前会员卡余额${balanceAfter}元。`;
  }
  if (category === 'pending') {
    return `您于${time}挂账${amount}元，当前会员卡余额${balanceAfter}元，请尽快到店结清。`;
  }
  return `您于${time}消费${amount}元，账户余额${balanceAfter}元。如非本人操作请联系M.77美肤空间门店。`;
}

async function sendWithTencent(item, phone, category = 'consume') {
  if (!tencentConfigured()) throw new Error('腾讯云短信参数未配置完整');
  const defaultTemplateId = process.env.TENCENT_SMS_TEMPLATE_ID;
  const templateId =
    category === 'recharge' ? (process.env.TENCENT_SMS_TEMPLATE_ID_RECHARGE || defaultTemplateId)
      : category === 'pending' ? (process.env.TENCENT_SMS_TEMPLATE_ID_PENDING || defaultTemplateId)
        : defaultTemplateId;
  const sdkModule = await import('tencentcloud-sdk-nodejs');
  const tencentcloud = sdkModule.default || sdkModule;
  const SmsClient = tencentcloud.sms.v20210111.Client;
  const client = new SmsClient({
    credential: {
      secretId: process.env.TENCENTCLOUD_SECRET_ID,
      secretKey: process.env.TENCENTCLOUD_SECRET_KEY,
    },
    region: 'ap-guangzhou',
    profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com', reqMethod: 'POST', reqTimeout: 10 } },
  });
  const params = item.templateParams;
  const response = await client.SendSms({
    SmsSdkAppId: process.env.TENCENT_SMS_SDK_APP_ID,
    SignName: process.env.TENCENT_SMS_SIGN_NAME,
    TemplateId: templateId,
    TemplateParamSet: [String(params.time), String(params.amount), String(params.balance)],
    PhoneNumberSet: [`+86${phone}`],
    SessionContext: item.id,
  });
  const status = response?.SendStatusSet?.[0];
  if (!status || status.Code !== 'Ok') {
    const error = new Error(status?.Message || '腾讯云未受理该短信');
    error.providerCode = status?.Code || 'UNKNOWN';
    throw error;
  }
  return { requestId: response.RequestId || status.SerialNo || null, code: status.Code };
}

export async function dispatchSmsNotification(id, { force = false } = {}) {
  if (force) {
    await prisma.smsNotification.updateMany({
      where: { id, status: { in: ['FAILED', 'PENDING'] } },
      data: { status: 'PENDING', attemptCount: 0, nextAttemptAt: null, errorMessage: null },
    });
  }

  const now = new Date();
  const claimed = await prisma.smsNotification.updateMany({
    where: {
      id, status: { in: ['PENDING', 'FAILED'] }, attemptCount: { lt: MAX_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: { status: 'SENDING', attemptCount: { increment: 1 }, lastAttemptAt: now, errorMessage: null },
  });
  if (claimed.count !== 1) return prisma.smsNotification.findUnique({ where: { id } });

  const item = await prisma.smsNotification.findUnique({
    where: { id },
    include: {
      member: { select: { phone: true, smsNotificationEnabled: true } },
      transaction: { select: { transactionType: true } },
    },
  });
  const category = transactionTypeCategory(item.transaction?.transactionType);
  if (!enabled()) {
    return prisma.smsNotification.update({
      where: { id }, data: { status: 'SKIPPED', errorMessage: '短信功能已关闭', nextAttemptAt: null },
    });
  }
  if (!item?.member?.smsNotificationEnabled || !MAINLAND_PHONE.test(item.member.phone)) {
    return prisma.smsNotification.update({
      where: { id },
      data: {
        status: 'SKIPPED', nextAttemptAt: null,
        errorMessage: !item?.member?.smsNotificationEnabled ? '会员已关闭消费短信通知' : '会员手机号格式无效',
      },
    });
  }
  try {
    if (item.provider === 'mock') {
      return prisma.smsNotification.update({
        where: { id },
        data: { status: 'SIMULATED', providerRequestId: `mock-${id}`, providerCode: 'MOCK_OK', nextAttemptAt: null },
      });
    }
    if (item.provider !== 'tencent') throw new Error(`不支持的短信通道：${item.provider}`);

    const sent = await sendWithTencent(item, item.member.phone, category);
    return prisma.smsNotification.update({
      where: { id },
      data: { status: 'ACCEPTED', providerRequestId: sent.requestId, providerCode: sent.code, nextAttemptAt: null },
    });
  } catch (error) {
    const attempts = item?.attemptCount || 1;
    const retryMinutes = Math.min(5 * (2 ** Math.max(attempts - 1, 0)), 60);
    return prisma.smsNotification.update({
      where: { id },
      data: {
        status: 'FAILED', providerCode: error.providerCode || null,
        errorMessage: safeError(error), nextAttemptAt: attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + retryMinutes * 60000),
      },
    });
  }
}

export function dispatchSmsSoon(id, logger = console) {
  if (!id) return;
  setTimeout(() => {
    dispatchSmsNotification(id).catch(error => logger.error?.({ err: error, smsNotificationId: id }, '短信队列处理失败'));
  }, 0);
}

export async function processPendingSms() {
  const now = new Date();
  // 进程若在调用供应商时崩溃，SENDING 不能永久卡住；5 分钟后恢复为可重试。
  await prisma.smsNotification.updateMany({
    where: { status: 'SENDING', lastAttemptAt: { lt: new Date(now.getTime() - 5 * 60000) } },
    data: { status: 'FAILED', nextAttemptAt: now, errorMessage: '发送进程中断，系统已自动恢复队列' },
  });
  const rows = await prisma.smsNotification.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED'] }, attemptCount: { lt: MAX_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    select: { id: true }, orderBy: { createdAt: 'asc' }, take: 20,
  });
  await Promise.allSettled(rows.map(row => dispatchSmsNotification(row.id)));
  return rows.length;
}

// --- P0 缺口补齐：回执状态机（依赖待决 Q-09 / Q-12，当前采用建议默认值）---
// 状态机：PENDING → SENDING → ACCEPTED（已受理，中间态）→ DELIVERED | REJECTED。
// 保留 SIMULATED / FAILED / SKIPPED；mock 分支仍只写 SIMULATED，绝不产生 DELIVERED。
// 本函数只由「默认关闭 + ADMIN/MANAGER 鉴权」的预留回调端点调用，不接腾讯云、不写密钥、不真实下发。
export class SmsReceiptError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// 回执文本脱敏：剔除完整手机号与常见凭据片段，并限制长度；台账不展示完整手机号 / 密钥。
function sanitizeReceiptText(value, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return String(value)
    .replace(/1[3-9]\d{9}/g, '****')
    .replace(/(AKID|SECRET|TOKEN|PASSWORD|SECRETKEY)[A-Za-z0-9_-]*/gi, '[REDACTED]')
    .slice(0, maxLength);
}

export async function applyReceipt(providerRequestId, payload, actor) {
  // actor 预留给未来真实回执接入时的操作人留痕；本轮不新增审计表，避免扩大范围。
  void actor;
  const requestId = String(providerRequestId || '').trim();
  if (!requestId) throw new SmsReceiptError('缺少 providerRequestId', 400);

  const terminalStatus = String(payload?.terminalStatus || '').trim().toUpperCase();
  if (!P0_GAP_POLICIES.SMS_TERMINAL_STATUSES.includes(terminalStatus)) {
    throw new SmsReceiptError('回执终态仅支持 DELIVERED 或 REJECTED', 400);
  }

  const target = await prisma.smsNotification.findFirst({
    where: { providerRequestId: requestId },
    orderBy: { createdAt: 'desc' },
  });
  if (!target) return null;

  // 已是终态：重复回调幂等 no-op，不重复写入、不重复计数。
  if (P0_GAP_POLICIES.SMS_TERMINAL_STATUSES.includes(target.status)) {
    return { smsNotification: target, idempotent: true };
  }
  // 只有「已受理」中间态可流转；SIMULATED（模拟）不得被显示为已送达。
  if (target.status !== P0_GAP_POLICIES.SMS_ACCEPTED_STATUS) {
    throw new SmsReceiptError('仅「已受理」的短信可以登记回执；模拟记录不会标记为已送达', 409);
  }

  let receiptAt = new Date();
  if (payload?.receiptAt) {
    const parsed = new Date(payload.receiptAt);
    if (Number.isNaN(parsed.getTime())) throw new SmsReceiptError('回执时间格式无效', 400);
    receiptAt = parsed;
  }

  const changed = await prisma.smsNotification.updateMany({
    where: { id: target.id, status: P0_GAP_POLICIES.SMS_ACCEPTED_STATUS },
    data: {
      status: terminalStatus,
      terminalStatus,
      receiptAt,
      rejectCode: terminalStatus === 'REJECTED' ? sanitizeReceiptText(payload?.rejectCode, 191) : null,
      rejectReason: terminalStatus === 'REJECTED' ? sanitizeReceiptText(payload?.rejectReason, 500) : null,
      receiptRequestId: sanitizeReceiptText(payload?.receiptRequestId || requestId, 191),
    },
  });
  const smsNotification = await prisma.smsNotification.findUnique({ where: { id: target.id } });
  return { smsNotification, idempotent: changed.count !== 1 };
}
