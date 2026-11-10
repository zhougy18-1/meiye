// frontend/app/src/api/appointment.js

import request from './index.js';

// --- 新增：获取当日预约数量的API函数 ---
export const getTodayAppointmentCount = () => {
  return request({
    url: '/appointments/count/today',
    method: 'get',
  });
};

export const getAppointments = (params) => {
  return request({
    url: '/appointments',
    method: 'get',
    params,
  });
};

// createAppointment 透传完整 data（含 customerType / sourceChannel / bedId 三个可空字段）。
export const createAppointment = (data) => {
  return request({
    url: '/appointments',
    method: 'post',
    data,
  });
};

// P0 缺口补齐 EP-11：按「床位 × 时段」查询某日剩余可约（date 为空时后端用门店今天）。
export const getAppointmentCapacity = (date) => {
  return request({
    url: '/appointments/capacity',
    method: 'get',
    params: date ? { date } : {},
  });
};

export const updateAppointmentStatus = (id, status) => {
  return request({
    url: `/appointments/${id}/status`,
    method: 'patch',
    data: { status },
  });
};
