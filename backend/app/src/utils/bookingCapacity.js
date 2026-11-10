// backend/app/src/utils/bookingCapacity.js
// 依赖待决 Q-07，当前采用建议默认值，待经营者确认后可调整：
// 床位 B1–B4 与时段网格一律从 config/p0GapPolicies.js 读取；
// 可约容量按「床位 × 时段」计算（capacity = BEDS.length − occupiedBedsInSlot），
// 不硬编码任何固定比例 / 0.5 新客预留。

import prisma from '../db/prisma.js';
import { P0_GAP_POLICIES, buildSlotGrid } from '../config/p0GapPolicies.js';
import { shopDayRange } from './shopTime.js';

const SHOP_OFFSET_MS = 8 * 60 * 60 * 1000;

export class BedConflictError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'BedConflictError';
  }
}

// date 为空时回退到门店本地「今天」（UTC+8），与 shopTime.js 口径一致。
function normalizeDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date(Date.now() + SHOP_OFFSET_MS).toISOString().slice(0, 10);
}

// 把 UTC 时刻换算为门店本地（UTC+8）时段值，并向下对齐到 SLOT_GRID 步长。
function slotKeyFor(value) {
  const local = new Date(new Date(value).getTime() + SHOP_OFFSET_MS);
  const hh = local.getUTCHours();
  const mm = local.getUTCMinutes();
  const step = P0_GAP_POLICIES.SLOT_GRID.minutes > 0 ? P0_GAP_POLICIES.SLOT_GRID.minutes : 30;
  const aligned = Math.floor(mm / step) * step;
  return `${String(hh).padStart(2, '0')}:${String(aligned).padStart(2, '0')}`;
}

// 返回 { date, beds, capacityBasis, slots: [{ slot, label, total, occupied, available, freeBeds }] }。
// 仅返回聚合占用数，不含会员手机号或完整经营数据。
export async function computeDailyCapacity(date, db = prisma) {
  const day = normalizeDate(date);
  const { start, end } = shopDayRange(day, day);
  const beds = P0_GAP_POLICIES.BEDS;
  const slots = buildSlotGrid();
  const rows = await db.appointment.findMany({
    where: {
      appointmentTime: { gte: start, lte: end },
      status: { in: P0_GAP_POLICIES.APPOINTMENT_ACTIVE_STATUSES },
      bedId: { not: null },
    },
    select: { appointmentTime: true, bedId: true },
  });

  const occupiedBySlot = new Map();
  for (const row of rows) {
    const key = slotKeyFor(row.appointmentTime);
    if (!occupiedBySlot.has(key)) occupiedBySlot.set(key, new Set());
    if (beds.includes(row.bedId)) occupiedBySlot.get(key).add(row.bedId);
  }

  return {
    date: day,
    beds: [...beds],
    capacityBasis: P0_GAP_POLICIES.CAPACITY_BASIS,
    slots: slots.map(slot => {
      const occupiedBeds = occupiedBySlot.get(slot.value) || new Set();
      const total = beds.length;
      const occupied = occupiedBeds.size;
      return {
        slot: slot.value,
        label: slot.label,
        total,
        occupied,
        available: Math.max(0, total - occupied),
        freeBeds: beds.filter(bedId => !occupiedBeds.has(bedId)),
      };
    }),
  };
}

// 同床位同时段（±1h 窗口，与既有「同手机号 ±1h」「同员工 ±1h」冲突检测一致）不可重复占用。
// bedId 为空（公开预约留空由店长补录）时不参与冲突判断。
export async function assertNoBedConflict(db, bedId, timeRange) {
  if (bedId == null || bedId === '') return;
  if (!P0_GAP_POLICIES.BEDS.includes(bedId)) {
    throw new BedConflictError('床位编码无效', 400);
  }
  const conflict = await db.appointment.findFirst({
    where: {
      bedId,
      appointmentTime: { gte: timeRange.start, lte: timeRange.end },
      status: { in: P0_GAP_POLICIES.APPOINTMENT_ACTIVE_STATUSES },
    },
    select: { id: true },
  });
  if (conflict) throw new BedConflictError('该床位在此时段已被占用');
}
