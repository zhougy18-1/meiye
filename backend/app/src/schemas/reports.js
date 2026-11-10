const dateRangeQuery = {
  type: 'object',
  required: ['startDate', 'endDate'],
  properties: {
    startDate: { type: 'string', format: 'date' },
    endDate: { type: 'string', format: 'date' }
  },
  additionalProperties: false
};

const optionalDateRangePagination = {
  type: 'object',
  properties: {
    startDate: { type: 'string', format: 'date' },
    endDate: { type: 'string', format: 'date' },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
  },
  additionalProperties: false
};

const paginationOnly = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
  },
  additionalProperties: false
};

export const businessReportSchema = { querystring: dateRangeQuery };
// 陷阱 T-02：/business/monthly 带 response[200]，fast-json-stringify 会剥离未声明字段，
// 因此三个并列新增字段必须在此显式声明，否则接口返回缺字段。
export const monthlyBusinessSchema = {
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          month: { type: 'string' },
          totalRevenue: { type: 'string' },
          totalRecharge: { type: 'string' },
          cardConsumption: { type: 'string' },
          pendingAdded: { type: 'string' },
          pendingCleared: { type: 'string' },
          totalCustomers: { type: 'integer' },
          averageOrderValue: { type: 'string' },
          newMembers: { type: 'integer' },
          packageRevenue: { type: 'string' },
          packageRefund: { type: 'string' },
          redeemedUses: { type: 'integer' }
        }
      }
    }
  }
};
export const paymentSummarySchema = { querystring: dateRangeQuery };
export const cardSalesSummarySchema = { querystring: dateRangeQuery };
export const serviceRankingSchema = { querystring: optionalDateRangePagination };
export const memberRankingSchema = { querystring: optionalDateRangePagination };
export const sleepingMembersSchema = { querystring: paginationOnly };
export const pendingStatsSchema = { querystring: paginationOnly };
