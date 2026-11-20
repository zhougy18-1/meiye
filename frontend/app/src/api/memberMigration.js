import request from './index.js';

export const getMigrationOptions = () => request({ url: '/member-migrations/options', method: 'get' });
export const downloadMigrationTemplate = () => request({ url: '/member-migrations/template', method: 'get', responseType: 'blob' });
export const previewMigration = data => request({ url: '/member-migrations/preview', method: 'post', data, timeout: 30000 });
export const getMigrationBatches = () => request({ url: '/member-migrations/batches', method: 'get' });
export const getMigrationBatch = id => request({ url: `/member-migrations/batches/${id}`, method: 'get' });
export const downloadMigrationReport = id => request({ url: `/member-migrations/batches/${id}/report`, method: 'get', responseType: 'blob' });
export const commitMigration = (id, acknowledgements) => request({ url: `/member-migrations/batches/${id}/commit`, method: 'post', data: { acknowledgements }, timeout: 30000 });
export const rollbackMigration = (id, reason) => request({ url: `/member-migrations/batches/${id}/rollback`, method: 'post', data: { reason }, timeout: 30000 });
