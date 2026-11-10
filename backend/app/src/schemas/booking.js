// 公开预约 schema
// 依赖待决 Q-05 / Q-06 / Q-07：三个新字段的枚举一律取自服务端唯一权威配置，
// 避免 additionalProperties:false 陷阱（T-01）与散落硬编码魔数。
import { P0_GAP_POLICIES } from '../config/p0GapPolicies.js';

const nullableEnum = values => ({ type: ['string', 'null'], enum: [...values, null] });

const codeQuery = {
  type: 'object',
  required: ['code'],
  properties: {
    code: { type: 'string', minLength: 2, maxLength: 32, pattern: '^[a-zA-Z0-9_]+$' },
    // EP-13：可选日期，用于返回该日「床位 × 时段」可约容量。
    date: { type: 'string', format: 'date' },
  },
  additionalProperties: false
};

export const bookingOptionsSchema = {
  querystring: codeQuery
};

export const createBookingSchema = {
  querystring: codeQuery,
  body: {
    type: 'object',
    required: ['customerPhone', 'appointmentTime', 'serviceIds'],
    properties: {
      customerName: { type: 'string', maxLength: 50 },
      customerPhone: { type: 'string', pattern: '^1[3-9]\\d{9}$' },
      appointmentTime: { type: 'string', minLength: 1 },
      serviceIds: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 191 },
        minItems: 1,
        maxItems: 20
      },
      assignedStaffId: { type: ['string', 'null'], maxLength: 191 },
      notes: { type: ['string', 'null'], maxLength: 500 },
      customerType: nullableEnum(P0_GAP_POLICIES.CUSTOMER_TYPES),
      sourceChannel: nullableEnum(P0_GAP_POLICIES.SOURCE_CHANNELS.map(channel => channel.code)),
      bedId: nullableEnum(P0_GAP_POLICIES.BEDS)
    },
    additionalProperties: false
  }
};
