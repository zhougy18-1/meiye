// backend/app/src/routes/users.js

import prisma from '../db/prisma.js';
import bcrypt from 'bcryptjs';
import { passwordChangeSchema } from '../schemas/auth.js';
import { managerUsername } from '../utils/shopIdentity.js';

export default async function (fastify, opts) {

  const routeOptions = {
    onRequest: [fastify.authenticate],
    schema: passwordChangeSchema,
  };

  // --- 优化：修改密码后使其所有设备下线 ---
  fastify.patch('/password', routeOptions, async (request, reply) => {
    const { id: userId } = request.user;
    const { oldPassword, newPassword } = request.body;

    const user = await prisma.user.findUnique({
      where: { id: userId } 
    });

    if (!user) {
      return reply.code(404).send({ message: '用户不存在' });
    }

    const isPasswordValid = await bcrypt.compare(oldPassword, user.password);
    if (!isPasswordValid) {
      return reply.code(400).send({ message: '旧密码不正确' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    // 使用 Prisma 事务，确保密码更新和令牌删除的原子性
    await prisma.$transaction(async (tx) => {
      // 1. 更新密码
      await tx.user.update({
        where: { id: userId },
        data: { password: hashedNewPassword },
      });

      // 2. 删除该用户所有的 Refresh Token，强制所有设备重新登录
      await tx.refreshToken.deleteMany({
        where: { userId: userId },
      });
    });

    return { message: '密码修改成功，为确保安全，您需要重新登录。' };
  });

  fastify.patch('/manager/password', {
    onRequest: [fastify.authenticate, fastify.hasRole('ADMIN')],
    schema: { body: {
      type: 'object', additionalProperties: false,
      required: ['ownerPassword', 'newPassword'],
      properties: {
        ownerPassword: { type: 'string', minLength: 1, maxLength: 100 },
        newPassword: { type: 'string', minLength: 10, maxLength: 100 },
      },
    } },
  }, async (request, reply) => {
    const owner = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (!owner || !await bcrypt.compare(request.body.ownerPassword, owner.password)) {
      return reply.code(400).send({ message: '老板密码不正确' });
    }
    if (await bcrypt.compare(request.body.newPassword, owner.password)) {
      return reply.code(400).send({ message: '店长密码不能与老板密码相同' });
    }
    const manager = await prisma.user.findUnique({ where: { username: managerUsername() } });
    if (!manager || manager.role !== 'MANAGER') {
      return reply.code(404).send({ message: '店长账号不存在，请先配置店长账号' });
    }
    const newHash = await bcrypt.hash(request.body.newPassword, 12);
    await prisma.$transaction(async tx => {
      await tx.user.update({
        where: { id: manager.id },
        data: { password: newHash },
      });
      await tx.refreshToken.deleteMany({ where: { userId: manager.id } });
    });
    request.log.info({ action: 'MANAGER_PASSWORD_RESET', actorId: owner.id, targetId: manager.id }, 'shop account change');
    return { message: '店长密码已更新，原有会话已失效' };
  });

  fastify.get('/manager', {
    onRequest: [fastify.authenticate, fastify.hasRole('ADMIN')],
  }, async (request, reply) => {
    const manager = await prisma.user.findUnique({
      where: { username: managerUsername() }, select: { id: true, username: true, role: true },
    });
    if (!manager || manager.role !== 'MANAGER') {
      return reply.code(404).send({ message: '店长账号不存在' });
    }
    return { username: manager.username };
  });
}
