import Decimal from 'decimal.js';
import { P0_GAP_POLICIES, computeRefundCap } from '../config/p0GapPolicies.js';

export class PackageError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.statusCode = statusCode;
  }
}

const includeHolding = {
  member: { select: { id: true, name: true, phone: true } },
  plan: { include: { service: { select: { id: true, name: true } } } },
  usages: { orderBy: { usedAt: 'desc' } },
};

function samePurchase(existing, input, actor) {
  if (existing.memberId !== input.memberId || existing.planId !== input.planId ||
      existing.paymentMethod !== input.paymentMethod || existing.createdBy !== actor.id ||
      !new Decimal(existing.paidAmount.toString()).equals(input.paidAmount)) {
    throw new PackageError('此请求编号已用于另一笔购买，请刷新后重试');
  }
  return existing;
}

function sameUsage(existing, holdingId, actor) {
  if (existing.holdingId !== holdingId || existing.usedBy !== actor.id) {
    throw new PackageError('此请求编号已用于另一笔扣次，请刷新后重试');
  }
}

// 退款/作废幂等：同一 requestKey 只能用于同一张卡、同一种动作、同一个操作人。
function sameCloseout(existing, holdingId, action, actor) {
  if (existing.holdingId !== holdingId || existing.action !== action || existing.operatorId !== actor.id) {
    throw new PackageError('此请求编号已用于另一笔退款/作废，请刷新后重试');
  }
}

// ReadCommitted + 带条件的 UPDATE 保证并发不能超扣；死锁重试仅重跑整笔事务。
async function atomic(db, action) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(action, { isolationLevel: 'ReadCommitted' });
    } catch (error) {
      if (error.code !== 'P2034' || attempt >= 2) throw error;
    }
  }
}

export function createPackageService(db) {
  const getHolding = (id, client = db) => client.packageHolding.findUnique({ where: { id }, include: includeHolding });
  return {
    async listHoldings(memberId) {
      return db.packageHolding.findMany({
        where: memberId ? { memberId } : {}, include: includeHolding,
        orderBy: { purchasedAt: 'desc' }, take: 500,
      });
    },
    async purchase(input, actor) {
      if (!new Decimal(input.paidAmount).greaterThan(0)) throw new PackageError('实收金额必须大于 0', 400);
      const prior = await db.packageHolding.findUnique({ where: { requestKey: input.requestKey }, include: includeHolding });
      if (prior) return samePurchase(prior, input, actor);
      try {
        return await atomic(db, async tx => {
          const [plan, member] = await Promise.all([
            tx.packagePlan.findUnique({ where: { id: input.planId }, include: { service: true } }),
            tx.member.findUnique({ where: { id: input.memberId } }),
          ]);
          if (!plan || !plan.active || plan.service.status !== 'AVAILABLE') throw new PackageError('套餐不存在、已停用或对应项目已下架', 400);
          if (!member || member.status !== 'ACTIVE') throw new PackageError('顾客不存在或已停用', 400);
          const purchasedAt = new Date();
          return tx.packageHolding.create({
            data: {
              memberId: input.memberId, planId: input.planId, planName: plan.name,
              totalUses: plan.totalUses, remainingUses: plan.totalUses,
              paidAmount: new Decimal(input.paidAmount).toFixed(2), paymentMethod: input.paymentMethod,
              purchasedAt,
              expiresAt: plan.validDays ? new Date(purchasedAt.getTime() + plan.validDays * 86400000) : null,
              createdBy: actor.id, createdByName: actor.username,
              requestKey: input.requestKey,
            }, include: includeHolding,
          });
        });
      } catch (error) {
        if (error.code !== 'P2002') throw error;
        const existing = await db.packageHolding.findUnique({ where: { requestKey: input.requestKey }, include: includeHolding });
        if (!existing) throw error;
        return samePurchase(existing, input, actor);
      }
    },
    async redeem(holdingId, input, actor) {
      const existing = await db.packageUsage.findUnique({ where: { requestKey: input.requestKey } });
      if (existing) {
        sameUsage(existing, holdingId, actor);
        return { holding: await getHolding(holdingId), usage: existing };
      }
      try {
        return await atomic(db, async tx => {
          const holding = await getHolding(holdingId, tx);
          if (!holding) throw new PackageError('次卡不存在', 404);
          const now = new Date();
          if (holding.status !== 'ACTIVE') throw new PackageError('次卡已暂停，不能扣次');
          if (holding.expiresAt && holding.expiresAt <= now) throw new PackageError('次卡已过期，不能扣次');
          if (!holding.plan.active || holding.plan.serviceId == null) throw new PackageError('套餐已停用，不能扣次');
          const service = await tx.service.findUnique({ where: { id: holding.plan.serviceId } });
          if (!service || service.status !== 'AVAILABLE') throw new PackageError('护理项目已下架，不能扣次');
          if (holding.member && (await tx.member.findUnique({ where: { id: holding.memberId } }))?.status !== 'ACTIVE') {
            throw new PackageError('顾客已停用，不能扣次');
          }
          const changed = await tx.packageHolding.updateMany({
            where: { id: holdingId, status: 'ACTIVE', remainingUses: { gt: 0 },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            data: { remainingUses: { decrement: 1 } },
          });
          if (changed.count !== 1) throw new PackageError('剩余次数不足或状态已变化，请刷新后重试');
          const usage = await tx.packageUsage.create({ data: {
            holdingId, requestKey: input.requestKey, usedBy: actor.id,
            usedByName: actor.username, note: input.note || null,
          } });
          return { holding: await getHolding(holdingId, tx), usage };
        });
      } catch (error) {
        if (error.code !== 'P2002') throw error;
        const usage = await db.packageUsage.findUnique({ where: { requestKey: input.requestKey } });
        if (!usage) throw error;
        sameUsage(usage, holdingId, actor);
        return { holding: await getHolding(holdingId), usage };
      }
    },
    async reverse(usageId, reason, actor) {
      return atomic(db, async tx => {
        const usage = await tx.packageUsage.findUnique({ where: { id: usageId } });
        if (!usage) throw new PackageError('扣次记录不存在', 404);
        const changed = await tx.packageUsage.updateMany({
          where: { id: usageId, reversedAt: null },
          data: { reversedAt: new Date(), reversedBy: actor.id, reversedByName: actor.username, reverseReason: reason },
        });
        if (changed.count !== 1) throw new PackageError('本次扣次已经撤销，不能重复恢复');
        // 允许恢复已过期或暂停卡的历史误扣，但不改变暂停/有效期，不因此获得使用权。
        const holding = await tx.packageHolding.findUnique({ where: { id: usage.holdingId } });
        if (!holding || holding.remainingUses >= holding.totalUses) throw new PackageError('次数台账不一致，请联系管理员核对');
        const restored = await tx.packageHolding.updateMany({
          where: { id: holding.id, remainingUses: { lt: holding.totalUses } },
          data: { remainingUses: { increment: 1 } },
        });
        if (restored.count !== 1) throw new PackageError('次数台账已变化，请刷新后重试');
        return {
          holding: await getHolding(usage.holdingId, tx),
          usage: await tx.packageUsage.findUnique({ where: { id: usageId } }),
        };
      });
    },
    // P0 缺口补齐：退款 / 作废。
    // 依赖待决 Q-01/Q-02/Q-03/Q-04，当前采用建议默认值，待经营者确认后可调整：
    // 单笔事务内完成状态变更 + 审计写入 + 剩余次数归零；requestKey 唯一幂等；
    // 不删除 PackageHolding / PackageUsage、不写旧 Transaction（WRITE_LEGACY_TRANSACTION=false）、
    // 不冗余复制购买快照（planName / totalUses / paidAmount / expiresAt 保持不动）。
    async closeout(holdingId, input, actor) {
      const action = String(input.action || '').toUpperCase();
      const policy = P0_GAP_POLICIES.REFUND_ACTIONS[action];
      if (!policy) throw new PackageError('不支持的退款/作废类型', 400);

      const requestKey = String(input.requestKey || '').trim();
      const reason = String(input.reason || '').trim();
      const approvedBy = String(input.approvedBy || '').trim();
      if (!requestKey) throw new PackageError('缺少请求编号', 400);
      if (!reason) throw new PackageError('请填写退款/作废原因', 400);
      if (!approvedBy && P0_GAP_POLICIES.PARTIAL_REFUND.requireApprover) throw new PackageError('请填写审批人', 400);

      let refundAmount = new Decimal(0);
      if (policy.hasAmount) {
        if (input.refundAmount == null || input.refundAmount === '') throw new PackageError('请填写退款金额', 400);
        refundAmount = new Decimal(input.refundAmount);
        if (!refundAmount.isFinite() || !refundAmount.greaterThan(0)) throw new PackageError('退款金额必须大于 0', 400);
      }

      const prior = await db.packageRefundAudit.findUnique({ where: { requestKey } });
      if (prior) {
        sameCloseout(prior, holdingId, action, actor);
        return { holding: await getHolding(holdingId), audit: prior };
      }

      try {
        return await atomic(db, async tx => {
          const holding = await getHolding(holdingId, tx);
          if (!holding) throw new PackageError('次卡不存在', 404);
          if (P0_GAP_POLICIES.CLOSED_STATUSES.includes(holding.status)) {
            throw new PackageError('次卡已退款或作废，不能重复处理');
          }
          if (!P0_GAP_POLICIES.CLOSEABLE_STATUSES.includes(holding.status)) {
            throw new PackageError('当前状态不能执行退款/作废，请刷新后重试');
          }

          // Q-02：按剩余次数比例计算可退上限，累计不超过实收金额。
          if (policy.hasAmount && P0_GAP_POLICIES.PARTIAL_REFUND.enabled) {
            const priorRefunds = await tx.packageRefundAudit.aggregate({
              where: { holdingId }, _sum: { refundAmount: true },
            });
            const cap = computeRefundCap({
              paidAmount: holding.paidAmount,
              totalUses: holding.totalUses,
              remainingUses: holding.remainingUses,
              alreadyRefunded: priorRefunds._sum.refundAmount || 0,
            });
            if (refundAmount.greaterThan(cap)) {
              throw new PackageError(`退款金额超过可退上限 ${cap.toFixed(2)} 元（按剩余次数比例，累计不超过实收）`, 400);
            }
          }

          // 条件 updateMany + count !== 1：并发下只有一次能改状态，其余抛业务错误。
          const changed = await tx.packageHolding.updateMany({
            where: { id: holdingId, status: { in: P0_GAP_POLICIES.CLOSEABLE_STATUSES } },
            data: { status: policy.targetStatus, remainingUses: P0_GAP_POLICIES.CLOSEOUT_REMAINING_USES },
          });
          if (changed.count !== 1) throw new PackageError('次卡状态已变化，请刷新后重试');

          // 时间由系统记录（occurredAt @default(now())）；操作人取 request.user；
          // approvedBy 为审批人标识/姓名快照字符串，不建 User 外键。
          const audit = await tx.packageRefundAudit.create({ data: {
            holdingId,
            action,
            refundAmount: refundAmount.toFixed(2),
            remainingUsesBefore: holding.remainingUses,
            remainingUsesAfter: P0_GAP_POLICIES.CLOSEOUT_REMAINING_USES,
            prevStatus: holding.status,
            reason,
            approvedBy,
            operatorId: actor.id,
            operatorName: actor.username,
            requestKey,
          } });
          // Q-04：独立台账原则，本事务内不写任何 Transaction 行。
          return { holding: await getHolding(holdingId, tx), audit };
        });
      } catch (error) {
        if (error.code !== 'P2002') throw error;
        const audit = await db.packageRefundAudit.findUnique({ where: { requestKey } });
        if (!audit) throw error;
        sameCloseout(audit, holdingId, action, actor);
        return { holding: await getHolding(holdingId), audit };
      }
    },
    async listAudits(holdingId) {
      return db.packageRefundAudit.findMany({
        where: { holdingId }, orderBy: { occurredAt: 'desc' },
      });
    },
    async summary() {
      const [totals, redeemedUses] = await Promise.all([
        db.packageHolding.aggregate({ _count: { id: true }, _sum: { paidAmount: true, remainingUses: true } }),
        db.packageUsage.count({ where: { reversedAt: null } }),
      ]);
      return { holdingCount: totals._count.id, paidAmount: totals._sum.paidAmount?.toFixed(2) || '0.00',
        remainingUses: totals._sum.remainingUses || 0, redeemedUses,
        accountingNote: '套餐收入单独统计，未合并原收银报表；扣次不重复计收款。退款/作废在套餐台账内留痕，并在报表以「套餐退款」分列。' };
    },
  };
}
