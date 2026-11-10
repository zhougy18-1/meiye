// frontend/app/src/api/booking.js

import axios from 'axios';

const publicApi = axios.create({
  baseURL: '/api/public/booking',
  timeout: 10000
});

publicApi.interceptors.response.use(
  (response) => response.data,
  (error) => Promise.reject(error)
);

// P0 缺口补齐 EP-13：可选 date 用于返回该日「床位 × 时段」可约容量。
// 不向顾客询问新老客 / 来源渠道 / 床位，三字段留空由店长在店务端补录。
export const getBookingOptions = (code, date) => {
  return publicApi({
    url: '/options',
    method: 'get',
    params: { code, ...(date ? { date } : {}) }
  });
};

export const createBooking = (code, data) => {
  return publicApi({
    url: '/',
    method: 'post',
    params: { code },
    data
  });
};
