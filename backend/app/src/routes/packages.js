import Decimal from 'decimal.js';
import { createPackageService, PackageError } from '../services/packages.js';
import { P0_GAP_POLICIES } from '../config/p0GapPolicies.js';

const id = { type: 'string', minLength: 1, maxLength: 191, pattern: '^[a-zA-Z0-9_-]+$' };
const money = { type: 'string', pattern: '^(0|[1-9][0-9]{0,7})(\\.[0-9]{1,2})?$' };
const requestKey = { type: 'string', minLength: 8, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' };
const params = { type: 'object', required: ['id'], properties: { id } };
const body = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const paymentMethods = ['CASH', 'WECHAT_PAY', 'ALIPAY', 'DOUYIN', 'MEITUAN', 'CARD_SWIPE', 'OTHER'];
// 退款/作废审计必填项：原因 + 审批人（时间由系统记录，操作人取 request.user）。
const reasonField = { type: 'string', minLength: 1, maxLength: 500 };
const approverField = { type: 'string', minLength: 1, maxLength: 191 };

export default async function packagesRoutes(fastify, opts) {
  const db = opts.db || (await import('../db/prisma.js')).default;
  const service = createPackageService(db);
  // 此模块自己强制鉴权，不依赖 register options 是否正确传入。
  fastify.addHook('onRequest', fastify.authenticate);
  const manager = async (request, reply) => {
    if (!['ADMIN', 'MANAGER'].includes(request.user?.role)) return reply.code(403).send({ message: '仅店长或管理员可以执行此操作' });
  };
  const handle = action => async (request, reply) => {
    try { return await action(request, reply); }
    catch (error) {
      if (error instanceof PackageError) return reply.code(error.statusCode).send({ message: error.message });
      throw error;
    }
  };

  fastify.get('/services', async () => db.service.findMany({ where: { status: 'AVAILABLE' },
    select: { id: true, name: true, standardPrice: true, status: true }, orderBy: { sortOrder: 'asc' } }));
  fastify.get('/plans', async () => db.packagePlan.findMany({ include: { service: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } }));
  fastify.post('/plans', { preHandler: manager, schema: { body: body({
    name: { type: 'string', minLength: 1, maxLength: 100 }, serviceId: id,
    totalUses: { type: 'integer', minimum: 1, maximum: 1000 }, price: money,
    validDays: { type: ['integer', 'null'], minimum: 1, maximum: 3650 },
  }, ['name', 'serviceId', 'totalUses', 'price']) } }, handle(async request => {
    const input = request.body;
    if (!input.name.trim() || !new Decimal(input.price).greaterThan(0)) throw new PackageError('套餐名称不能为空，价格必须大于 0', 400);
    const item = await db.service.findUnique({ where: { id: input.serviceId } });
    if (!item || item.status !== 'AVAILABLE') throw new PackageError('请选择可用的护理项目', 400);
    return db.packagePlan.create({ data: { ...input, name: input.name.trim(), price: new Decimal(input.price).toFixed(2), createdBy: request.user.id }, include: { service: true } });
  }));
  fastify.get('/holdings', { schema: { querystring: body({ memberId: id }, []) } }, request => service.listHoldings(request.query.memberId));
  fastify.post('/holdings', { preHandler: manager, schema: { body: body({ memberId: id, planId: id, paidAmount: money,
    paymentMethod: { type: 'string', enum: paymentMethods }, requestKey }) } }, handle(request => service.purchase(request.body, request.user)));
  fastify.post('/holdings/:id/redeem', { schema: { params, body: body({ requestKey, note: { type: 'string', maxLength: 500 } }, ['requestKey']) } },
    handle(request => service.redeem(request.params.id, request.body, request.user)));
  fastify.post('/usages/:id/reverse', { preHandler: manager, schema: { params, body: body({ reason: { type: 'string', minLength: 1, maxLength: 500 } }) } },
    handle(request => {
      if (!request.body.reason.trim()) throw new PackageError('请填写撤销原因', 400);
      return service.reverse(request.params.id, request.body.reason.trim(), request.user);
    }));
  fastify.patch('/holdings/:id/status', { preHandler: manager, schema: { params, body: body({ status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] } }) } },
    handle(async request => {
      const holding = await db.packageHolding.findUnique({ where: { id: request.params.id } });
      if (!holding) throw new PackageError('次卡不存在', 404);
      // 终态不可逆：已退款/作废的套餐不允许通过暂停/恢复接口回到 ACTIVE 后再扣次。
      if (P0_GAP_POLICIES.CLOSED_STATUSES.includes(holding.status)) {
        throw new PackageError('已退款或作废的套餐不可再变更状态');
      }
      return db.packageHolding.update({ where: { id: request.params.id }, data: { status: request.body.status } });
    }));
  fastify.get('/summary', service.summary);

  // --- P0 缺口补齐 EP-01 / EP-02：退款 / 作废（ADMIN/MANAGER，其余角色 403）---
  fastify.post('/holdings/:id/refund', {
    preHandler: manager,
    schema: { params, body: body({ requestKey, refundAmount: money, reason: reasonField, approvedBy: approverField }) },
  }, handle(request => service.closeout(request.params.id, {
    ...request.body,
    reason: request.body.reason.trim(),
    approvedBy: request.body.approvedBy.trim(),
    action: 'REFUND',
  }, request.user)));

  fastify.post('/holdings/:id/void', {
    preHandler: manager,
    schema: { params, body: body({ requestKey, reason: reasonField, approvedBy: approverField }) },
  }, handle(request => service.closeout(request.params.id, {
    ...request.body,
    reason: request.body.reason.trim(),
    approvedBy: request.body.approvedBy.trim(),
    action: 'VOID',
  }, request.user)));

  // --- P0 缺口补齐 EP-03：审计记录（只读留痕，四级可读，仅模块级 authenticate）---
  fastify.get('/holdings/:id/audits', { schema: { params } }, handle(request => service.listAudits(request.params.id)));
}
