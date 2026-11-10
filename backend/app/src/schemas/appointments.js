// 依赖待决 Q-05 / Q-06 / Q-07：新字段枚举取自服务端唯一权威配置（p0GapPolicies.js）。
// 陷阱 T-01：createAppointmentSchema 为 additionalProperties:false，必须显式加入三个新字段。
import { P0_GAP_POLICIES } from '../config/p0GapPolicies.js';

const nullableEnum = values => ({ type: ['string', 'null'], enum: [...values, null] });
const appointmentStatusEnum = ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

export const createAppointmentSchema = {
  body: {
    type: 'object',
    required: ['customerPhone', 'appointmentTime', 'serviceIds'],
    properties: {
      memberId: { type: ['string', 'null'], maxLength: 191 },
      customerName: { type: ['string', 'null'], maxLength: 50 },
      customerPhone: { type: 'string', minLength: 1, maxLength: 20 },
      appointmentTime: { type: 'string', minLength: 1 },
      assignedStaffId: { type: ['string', 'null'], maxLength: 191 },
      serviceIds: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 191 },
        minItems: 1,
        maxItems: 20
      },
      notes: { type: ['string', 'null'], maxLength: 500 },
      customerType: nullableEnum(P0_GAP_POLICIES.CUSTOMER_TYPES),
      sourceChannel: nullableEnum(P0_GAP_POLICIES.SOURCE_CHANNELS.map(channel => channel.code)),
      bedId: nullableEnum(P0_GAP_POLICIES.BEDS)
    },
    additionalProperties: false
  }
};

// EP-11：可约容量查询（date 可选，为空时后端回退门店本地今天）。
export const capacityQuerySchema = {
  querystring: {
    type: 'object',
    properties: {
      date: { type: 'string', format: 'date' }
    },
    additionalProperties: false
  }
};

export const updateAppointmentStatusSchema = {
  body: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: appointmentStatusEnum }
    },
    additionalProperties: false
  }
};

export const appointmentsQuerySchema = {
  querystring: {
    type: 'object',
    properties: {
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      staffId: { type: 'string', maxLength: 191 },
      status: { type: 'string', enum: appointmentStatusEnum }
    },
    additionalProperties: false
  }
};
