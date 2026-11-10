import request from './index.js';

export const getPackageSummary = () => request({ url: '/packages/summary', method: 'get' });
export const getPackagePlans = () => request({ url: '/packages/plans', method: 'get' });
export const createPackagePlan = (data) => request({ url: '/packages/plans', method: 'post', data });
export const getPackageServices = () => request({ url: '/packages/services', method: 'get' });
export const getPackageHoldings = (params) => request({ url: '/packages/holdings', method: 'get', params });
export const purchasePackage = (data) => request({ url: '/packages/holdings', method: 'post', data });
export const redeemPackage = (id, data) => request({ url: `/packages/holdings/${id}/redeem`, method: 'post', data });
export const reversePackageUsage = (id, data) => request({ url: `/packages/usages/${id}/reverse`, method: 'post', data });
export const setPackageStatus = (id, status) => request({ url: `/packages/holdings/${id}/status`, method: 'patch', data: { status } });

// P0 缺口补齐：退款 / 作废 / 审计（EP-01 / EP-02 / EP-03）
export const refundPackage = (id, data) => request({ url: `/packages/holdings/${id}/refund`, method: 'post', data });
export const voidPackage = (id, data) => request({ url: `/packages/holdings/${id}/void`, method: 'post', data });
export const getPackageAudits = (id) => request({ url: `/packages/holdings/${id}/audits`, method: 'get' });
