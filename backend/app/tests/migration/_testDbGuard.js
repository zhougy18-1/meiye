export function assertDedicatedMigrationTestDatabase() {
  if (process.env.NODE_ENV !== 'test') throw new Error('迁移写入测试只能在 NODE_ENV=test 下运行');
  let url;
  try { url = new URL(process.env.DATABASE_URL); }
  catch { throw new Error('迁移写入测试缺少有效的 DATABASE_URL'); }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const namedTestDatabase = /(?:^|[_-])test(?:$|[_-])/i.test(database);
  if ((!localHost || !namedTestDatabase) && process.env.MIGRATION_TEST_DB_WRITE_OK !== 'true') {
    throw new Error(`拒绝对非本机专用测试库执行迁移写入测试：${url.hostname}/${database}`);
  }
}
