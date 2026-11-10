import request from './index.js';

export const getSmsConfig = () => request({ url: '/sms-notifications/config', method: 'get' });
export const getSmsNotifications = params => request({ url: '/sms-notifications', method: 'get', params });
export const retrySmsNotification = id => request({ url: `/sms-notifications/${id}/retry`, method: 'post' });
