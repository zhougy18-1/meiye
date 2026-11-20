import { createMigrationReportWorkbook, createTemplateWorkbook } from '../services/migrationExcel.js';
import { createMemberMigrationService, MemberMigrationError } from '../services/memberMigration.js';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 191 } } };

export default async function memberMigrationRoutes(fastify, opts) {
  const db = opts.db || (await import('../db/prisma.js')).default;
  const service = createMemberMigrationService(db);
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.user?.role !== 'ADMIN') return reply.code(403).send({ message: '仅老板账号可以管理历史数据迁移' });
  });
  const handle = action => async (request, reply) => {
    try { return await action(request, reply); }
    catch (error) {
      if (error instanceof MemberMigrationError) return reply.code(error.statusCode).send({ message: error.message, details: error.details });
      throw error;
    }
  };

  fastify.get('/options', handle(() => service.options()));
  fastify.get('/template', handle(async (_request, reply) => {
    const buffer = await createTemplateWorkbook();
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', "attachment; filename*=UTF-8''%E9%9D%92%E5%8F%B8%E7%B3%BB%E7%BB%9F_M77%E4%BC%9A%E5%91%98%E8%B5%84%E6%96%99%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF.xlsx");
    return reply.send(buffer);
  }));
  fastify.post('/preview', { bodyLimit: 8 * 1024 * 1024 }, handle(request => service.preview(request.body || {}, request.user)));
  fastify.get('/batches', handle(() => service.list()));
  fastify.get('/batches/:id', { schema: { params: idParams } }, handle(request => service.get(request.params.id)));
  fastify.get('/batches/:id/report', { schema: { params: idParams } }, handle(async (request, reply) => {
    const batch = await service.get(request.params.id);
    const buffer = await createMigrationReportWorkbook(batch);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', `attachment; filename*=UTF-8''M77-member-migration-${encodeURIComponent(batch.id)}.xlsx`);
    return reply.send(buffer);
  }));
  fastify.post('/batches/:id/commit', { schema: { params: idParams } }, handle(request => service.commit(request.params.id, request.body?.acknowledgements, request.user)));
  fastify.post('/batches/:id/rollback', { schema: { params: idParams } }, handle(request => service.rollback(request.params.id, request.body?.reason, request.user)));
}
