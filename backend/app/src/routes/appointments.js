// backend/app/src/routes/appointments.js

import prisma from '../db/prisma.js';
import { generateUniqueId } from '../utils/id.js';
import {
  createAppointmentSchema,
  updateAppointmentStatusSchema,
  appointmentsQuerySchema,
  capacityQuerySchema,
} from '../schemas/appointments.js';
import { applyAuth } from '../utils/applyAuth.js';
import { shopDayRange, shopTodayRange } from '../utils/shopTime.js';
import { computeDailyCapacity, assertNoBedConflict, BedConflictError } from '../utils/bookingCapacity.js';

export default async function (fastify, opts) {
  applyAuth(fastify, opts);

  fastify.get('/count/today', async (request, reply) => {
    const { start: startOfToday, end: endOfToday } = shopTodayRange();

    const count = await prisma.appointment.count({
      where: {
        appointmentTime: {
          gte: startOfToday,
          lte: endOfToday,
        },
        // --- 核心修改：只统计“待确认”和“已确认”的预约 ---
        status: {
          in: ['PENDING', 'CONFIRMED']
        }
      }
    });

    return { count };
  });

  // P0 缺口补齐 EP-11：可约容量（四级可读，仅返回聚合占用数，不含会员手机号 / 完整经营数据）。
  fastify.get('/capacity', { schema: capacityQuerySchema }, async request => {
    return computeDailyCapacity(request.query.date);
  });

  fastify.post('/', { schema: createAppointmentSchema }, async (request, reply) => {

    const {
        memberId,
        customerName,
        customerPhone,
        appointmentTime,
        assignedStaffId,
        serviceIds,
        notes,
        customerType,
        sourceChannel,
        bedId,
      } = request.body;

    // 已保存会员的号码对店长只显示脱敏值，入库时须从会员资料取真实号码。
    const linkedMember = memberId ? await prisma.member.findUnique({
      where: { id: memberId }, select: { phone: true },
    }) : null;
    if (memberId && !linkedMember) return reply.code(404).send({ message: '会员不存在' });

    // 陷阱 T-06：店内 POST 原无任何冲突检测，本轮只新增床位冲突，
    // 不补手机号/员工 ±1h 检测（既有检测只在公开 booking.js，属不变更项）。
    const appointmentDate = new Date(appointmentTime);
    const timeRangeStart = new Date(appointmentDate.getTime() - 60 * 60 * 1000);
    const timeRangeEnd = new Date(appointmentDate.getTime() + 60 * 60 * 1000);
    try {
      await assertNoBedConflict(prisma, bedId, { start: timeRangeStart, end: timeRangeEnd });
    } catch (error) {
      if (error instanceof BedConflictError) return reply.code(error.statusCode).send({ message: error.message });
      throw error;
    }

      const newAppointment = await prisma.appointment.create({
        data: {
          id: await generateUniqueId(prisma.appointment),
          customerName: customerName || '非会员用户',
          customerPhone: linkedMember?.phone || customerPhone,
          appointmentTime: appointmentDate,
          notes,
          status: 'PENDING',
          services: { connect: serviceIds.map(id => ({ id })) },
          ...(memberId && { member: { connect: { id: memberId } } }),
          ...(assignedStaffId && { staff: { connect: { id: assignedStaffId } } }),
          // T-07：三个新字段加入 create data，全部可空。
          customerType: customerType || null,
          sourceChannel: sourceChannel || null,
          bedId: bedId || null,
        },
        include: {
          member: true,
          staff: true,
          services: true,
        },
      });
      return newAppointment;

  });

  fastify.get('/', { schema: appointmentsQuerySchema }, async (request, reply) => {
    const { startDate, endDate, staffId, status } = request.query;
    const where = {};

    if (startDate && endDate) {
        const { start, end } = shopDayRange(startDate, endDate);
        where.appointmentTime = { gte: start, lte: end };
    }
    if (staffId) {
        where.assignedStaffId = staffId;
    }
    if (status) {
        where.status = status;
    }

      const appointments = await prisma.appointment.findMany({
        where,
        include: {
          member: { select: { id: true, name: true, phone: true } },
          staff: { select: { id: true, name: true } },
          services: { select: { id: true, name: true } },
        },
        orderBy: { appointmentTime: 'asc' },
      });
      return appointments;

  });

  fastify.patch('/:id/status', { schema: updateAppointmentStatusSchema }, async (request, reply) => {
      const { id } = request.params;
      const { status } = request.body;

          const updatedAppointment = await prisma.appointment.update({
              where: { id },
              data: { status },
          });
          return updatedAppointment;

  });
}
