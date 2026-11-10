// backend/app/src/config/p0GapPolicies.js
// P0 缺口补齐业务口径的「服务端唯一权威」。
// 前端 frontend/app/src/constants/p0Gap.js 仅为展示镜像（下拉选项 / 标签），不参与业务判定。
// ---------------------------------------------------------------------------
// 全部键均标注「依赖待决 Q-xx，当前采用建议默认值，待经营者确认后可调整」。
// 任何涉及退款口径、报表口径、渠道定义、床位口径的最终取值，须按 v1.2 第 16 节第 6 条
// 取得经营者确认后，只改本文件，禁止散落硬编码魔数。
// ---------------------------------------------------------------------------

import Decimal from 'decimal.js';

// 依赖待决 Q-12：真实短信下发需要外部审核，本轮不启动；回执回调端点默认关闭。
// 仅当本地验收需要临时注入「模拟回执」时，允许用环境变量显式打开，仍由本模块统一裁决，
// 避免其它模块各自读取环境变量造成口径漂移。
function readBooleanEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export const P0_GAP_POLICIES = Object.freeze({
  // 依赖待决 Q-01，当前采用建议默认值，待经营者确认后可调整：
  // 退款＝有实际退款金额并退还顾客；作废＝无退款金额（录入错误 / 赠卡作废）。
  // 两者均不删除套餐、均需原因 + 审批人 + 时间、均置为不可再扣次。
  REFUND_ACTIONS: Object.freeze({
    REFUND: Object.freeze({ hasAmount: true, targetStatus: 'REFUNDED' }),
    VOID: Object.freeze({ hasAmount: false, targetStatus: 'VOID' }),
  }),
  // 允许执行退款/作废的前置状态（依赖待决 Q-01/Q-03）。
  CLOSEABLE_STATUSES: Object.freeze(['ACTIVE', 'PAUSED']),
  // 终态：不可逆、不可再扣次（依赖待决 Q-03）。
  CLOSED_STATUSES: Object.freeze(['REFUNDED', 'VOID']),

  // 依赖待决 Q-02，当前采用建议默认值，待经营者确认后可调整：
  // 按剩余次数比例计算可退上限，允许部分退款但累计不超过实收金额，需审批人，不允许超额退款。
  PARTIAL_REFUND: Object.freeze({
    enabled: true,
    basis: 'REMAINING_USES_RATIO',
    maxCumulative: 'PAID_AMOUNT',
    requireApprover: true,
    allowExceedPaid: false,
  }),

  // 依赖待决 Q-03，当前采用建议默认值，待经营者确认后可调整：
  // 退款/作废后剩余次数归零、状态置 REFUNDED/VOID、不可再扣次；已履约次数保留历史。
  CLOSEOUT_REMAINING_USES: 0,

  // 依赖待决 Q-04，当前采用建议默认值，待经营者确认后可调整：
  // 退款不写入旧 Transaction（沿用 schema.prisma:334 独立台账原则，避免旧撤销逻辑破坏履约余额）。
  WRITE_LEGACY_TRANSACTION: false,

  // 依赖待决 Q-05，当前采用建议默认值，待经营者确认后可调整：
  // 以该会员在本店是否有历史成交（NORMAL 交易 / 套餐购买）判定新客，首次成交前为新客。
  CUSTOMER_TYPE_RULE: 'HISTORICAL_TRANSACTION',
  CUSTOMER_TYPES: Object.freeze(['NEW', 'RETURNING']),

  // 依赖待决 Q-06，当前采用建议默认值，待经营者确认后可调整：
  // 来源渠道固定 7 项枚举，不用自由文本，避免报表口径漂移。
  SOURCE_CHANNELS: Object.freeze([
    { code: 'DOUYIN', label: '抖音' },
    { code: 'XIAOHONGSHU', label: '小红书' },
    { code: 'MEITUAN_DIANPING', label: '美团点评' },
    { code: 'WECHAT_PRIVATE', label: '微信私域' },
    { code: 'WALK_IN', label: '自然到店' },
    { code: 'REFERRAL', label: '转介绍' },
    { code: 'OTHER', label: '其他' },
  ]),

  // 依赖待决 Q-07，当前采用建议默认值，待经营者确认后可调整：
  // v1.2 3.4-A「4 个床位」B1–B4；可约容量按「床位 × 时段」计算，不硬编码固定比例。
  BEDS: Object.freeze(['B1', 'B2', 'B3', 'B4']),
  CAPACITY_BASIS: 'BEDS_X_SLOTS',
  SLOT_GRID: Object.freeze({ startHour: 8, endHour: 22, minutes: 30 }),
  // 店长每周新客床位预留：本轮不启用（依赖待决 Q-07）。
  NEW_CUSTOMER_BED_RESERVATION: null,
  // 参与床位占用/冲突判定的预约状态（与 booking.js 既有冲突检测口径一致）。
  APPOINTMENT_ACTIVE_STATUSES: Object.freeze(['PENDING', 'CONFIRMED']),

  // 依赖待决 Q-08，当前采用建议默认值，待经营者确认后可调整：
  // 套餐实收按 purchasedAt、退款按审计 occurredAt、履约次数取 usedAt 且 reversedAt=null 的 PackageUsage 条数。
  REPORT_PACKAGE_TIME: Object.freeze({
    packageRevenueField: 'purchasedAt',
    packageRefundField: 'occurredAt',
    redeemedUsesField: 'usedAt',
    redeemedUsesExcludeReversed: true,
  }),

  // 依赖待决 Q-09，当前采用建议默认值，待经营者确认后可调整：
  // 新增 DELIVERED（已送达）/ REJECTED（运营商退回）终态，保留 ACCEPTED（已受理）为中间态。
  SMS_TERMINAL_STATUSES: Object.freeze(['DELIVERED', 'REJECTED']),
  SMS_KEEP_ACCEPTED_INTERMEDIATE: true,
  SMS_ACCEPTED_STATUS: 'ACCEPTED',
  SMS_SIMULATED_STATUS: 'SIMULATED',
  SMS_ALLOWED_STATUSES: Object.freeze([
    'PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'REJECTED', 'SIMULATED', 'FAILED', 'SKIPPED',
  ]),

  // 依赖待决 Q-12，当前采用建议默认值，待经营者确认后可调整 / 需要外部审核：
  // 真实短信不启动；回执回调端点默认关闭（启用仍需 ADMIN/MANAGER 鉴权）。
  ENABLE_REAL_SMS: false,
  SMS_RECEIPT_CALLBACK_ENABLED: readBooleanEnv('SMS_RECEIPT_CALLBACK_ENABLED', false),

  // 依赖待决 Q-10，当前采用建议默认值，待经营者确认后可调整：
  // 本轮补建四级演示账号；账号名固定，凭据仅环境变量注入，不落文档 / Git / 日志。
  DEMO_ROLES: Object.freeze(['ADMIN', 'MANAGER', 'STYLIST', 'ASSISTANT']),
  DEMO_STAFF_USERNAMES: Object.freeze({
    MANAGER: 'manager@m77.demo',
    STYLIST: 'stylist@m77.demo',
    ASSISTANT: 'assistant@m77.demo',
  }),

  // 依赖待决 Q-11，当前采用建议默认值，待经营者确认后可调整：
  // local_lan 属部署形态，不在本轮 6 个检查点内（范围决策，非运行时开关）。
  INCLUDE_LOCAL_LAN_MODE: false,
});

// 依赖待决 Q-02：按剩余次数比例计算单笔可退上限，并扣减该卡已累计退款额。
// 返回 decimal.js Decimal，永不返回负值；累计不超过实收金额（allowExceedPaid=false）。
export function computeRefundCap({ paidAmount, totalUses, remainingUses, alreadyRefunded = 0 }) {
  const paid = new Decimal(paidAmount == null ? 0 : paidAmount.toString());
  const total = Number(totalUses) || 0;
  const remaining = Math.max(0, Number(remainingUses) || 0);
  const prior = new Decimal(alreadyRefunded == null ? 0 : alreadyRefunded.toString());
  if (total <= 0 || paid.lessThanOrEqualTo(0)) return new Decimal(0);
  const policy = P0_GAP_POLICIES.PARTIAL_REFUND;
  const ratioCap = policy.basis === 'REMAINING_USES_RATIO'
    ? paid.times(remaining).div(total)
    : paid;
  const cumulativeCap = policy.maxCumulative === 'PAID_AMOUNT' ? paid.minus(prior) : ratioCap;
  let cap = Decimal.min(ratioCap, cumulativeCap);
  if (!policy.allowExceedPaid) cap = Decimal.min(cap, paid);
  return cap.isNegative() ? new Decimal(0) : cap;
}

// 依赖待决 Q-05：有无历史成交 → 新老客标识（服务端判定，不由员工随意改）。
export function resolveCustomerType(hasHistoricalTransaction) {
  return hasHistoricalTransaction ? 'RETURNING' : 'NEW';
}

// 依赖待决 Q-07：床位 × 时段网格（08:00–22:00 / 30 分钟），不引入任何新客预留比例。
// 与前端 timeSlots / appointmentHour 的展示网格一致；后续调整须两处同步。
export function buildSlotGrid() {
  const { startHour, endHour, minutes } = P0_GAP_POLICIES.SLOT_GRID;
  const step = minutes > 0 ? minutes : 30;
  const slots = [];
  for (let offset = 0; startHour * 60 + offset < endHour * 60; offset += step) {
    const totalMinutes = startHour * 60 + offset;
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    const endMinutes = totalMinutes + step;
    const endHh = String(Math.floor(endMinutes / 60)).padStart(2, '0');
    const endMm = String(endMinutes % 60).padStart(2, '0');
    slots.push({ value: `${hh}:${mm}`, label: `${hh}:${mm} - ${endHh}:${endMm}` });
  }
  return slots;
}

// 依赖待决 Q-06：来源渠道码校验（前端只做展示，后端为唯一权威）。
export function isValidSourceChannel(code) {
  return P0_GAP_POLICIES.SOURCE_CHANNELS.some(channel => channel.code === code);
}

// 依赖待决 Q-07：床位编码校验。
export function isValidBed(bedId) {
  return P0_GAP_POLICIES.BEDS.includes(bedId);
}
