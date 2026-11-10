import prisma from '../db/prisma.js';
import {
  dispatchSmsNotification, getSmsRuntimeConfig, applyReceipt, SmsReceiptError,
} from '../services/sms.js';
import { P0_GAP_POLICIES } from '../config/p0GapPolicies.js';

// 依赖待决 Q-09：状态由 6 态扩到 8 态（+DELIVERED 已送达 / +REJECTED 运营商退回），
// 与 groupBy 计数、前端 SmsNotificationView.vue 筛选标签三处同步。
const allowedStatuses = P0_GAP_POLICIES.SMS_ALLOWED_STATUSES;

function view(row) {
  return {
    ...row,
    amount: row.amount.toFixed(2),
    balanceAfter: row.balanceAfter.toFixed(2),
    phoneMasked: `*******${row.phoneLast4}`,
    phoneLast4: undefined,
  };
}

export default async function smsNotificationRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.addHook('onRequest', fastify.hasRole(['ADMIN', 'MANAGER']));

  fastify.get('/config', async () => getSmsRuntimeConfig());

  fastify.get('/', {
    schema: { querystring: {
      type: 'object', additionalProperties: false,
      properties: {
        page: { type: 'integer', minimum: 1, default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        status: { type: 'string', enum: allowedStatuses },
      },
    } },
  }, async request => {
    const page = request.query.page || 1;
    const limit = request.query.limit || 20;
    const where = request.query.status ? { status: request.query.status } : {};
    const [rows, total, grouped] = await Promise.all([
      prisma.smsNotification.findMany({
        where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' },
        include: { member: { select: { id: true, name: true } }, transaction: { select: { id: true } } },
      }),
      prisma.smsNotification.count({ where }),
      prisma.smsNotification.groupBy({ by: ['status'], _count: { id: true } }),
    ]);
    return { data: rows.map(view), total, page, limit, counts: Object.fromEntries(grouped.map(item => [item.status, item._count.id])) };
  });

  fastify.post('/:id/retry', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 191 } } } },
  }, async (request, reply) => {
    const existing = await prisma.smsNotification.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.code(404).send({ message: '短信记录不存在' });
    if (!['FAILED', 'PENDING'].includes(existing.status)) return reply.code(409).send({ message: '当前状态不能重试' });
    return view(await dispatchSmsNotification(existing.id, { force: true }));
  });

  // --- P0 缺口补齐 EP-06：回执回调「预留端点」---
  // 依赖待决 Q-09 / Q-12：默认关闭（404）；启用后继承模块级 authenticate + hasRole(ADMIN,MANAGER)，
  // STYLIST / ASSISTANT 返回 403。按 providerRequestId 幂等；不接腾讯云、不写密钥、不产生真实下发。
  fastify.post('/receipts/callback', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['providerRequestId', 'terminalStatus'],
        properties: {
          providerRequestId: { type: 'string', minLength: 1, maxLength: 191 },
          terminalStatus: { type: 'string', enum: P0_GAP_POLICIES.SMS_TERMINAL_STATUSES },
          receiptAt: { type: 'string', minLength: 1, maxLength: 64 },
          rejectCode: { type: 'string', maxLength: 191 },
          rejectReason: { type: 'string', maxLength: 500 },
          receiptRequestId: { type: 'string', maxLength: 191 },
        },
      },
    },
  }, async (request, reply) => {
    if (!P0_GAP_POLICIES.SMS_RECEIPT_CALLBACK_ENABLED) {
      return reply.code(404).send({ message: '回执回调端点未启用' });
    }
    try {
      const result = await applyReceipt(request.body.providerRequestId, request.body, request.user);
      if (!result) return reply.code(404).send({ message: '未找到对应的短信记录' });
      return { smsNotification: view(result.smsNotification), idempotent: result.idempotent };
    } catch (error) {
      if (error instanceof SmsReceiptError) return reply.code(error.statusCode).send({ message: error.message });
      throw error;
    }
  });
}
