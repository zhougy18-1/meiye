import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDedicatedMigrationTestDatabase } from './_testDbGuard.js';

process.env.NODE_ENV = 'test';
assertDedicatedMigrationTestDatabase();
const { default: prisma } = await import('../../src/db/prisma.js');
const { queueTransactionSms } = await import('../../src/services/sms.js');

const memberId = 'migration-null-phone-member';
const transactionId = 'migration-null-phone-transaction';

async function clear() {
  await prisma.smsNotification.deleteMany({ where: { transactionId } });
  await prisma.transaction.deleteMany({ where: { id: transactionId } });
  await prisma.member.deleteMany({ where: { id: memberId } });
}

test('空手机号会员启用短信时收银事务仍成功，通知安全标记为 SKIPPED', async t => {
  await clear();
  t.after(async () => { await clear(); await prisma.$disconnect(); });
  const oldEnabled = process.env.SMS_ENABLED;
  const oldProvider = process.env.SMS_PROVIDER;
  process.env.SMS_ENABLED = 'true';
  process.env.SMS_PROVIDER = 'mock';
  try {
    await prisma.$transaction(async tx => {
      await tx.member.create({ data: { id: memberId, name: '空手机号迁移测试', phone: null, smsNotificationEnabled: true } });
      const transaction = await tx.transaction.create({ data: {
        id: transactionId, memberId, customerName: '空手机号迁移测试', totalAmount: '10.00', actualPaidAmount: '10.00',
        discountAmount: '0.00', paymentMethod: 'CASH', transactionType: 'NORMAL', transactionTime: new Date(),
      } });
      const queued = await queueTransactionSms(tx, transaction);
      assert.equal(queued.status, 'SKIPPED');
      assert.equal(queued.phoneLast4, '****');
      assert.match(queued.errorMessage, /手机号格式无效/);
    });
    assert.equal(await prisma.transaction.count({ where: { id: transactionId } }), 1);
    assert.equal(await prisma.smsNotification.count({ where: { transactionId, status: 'SKIPPED' } }), 1);
  } finally {
    if (oldEnabled === undefined) delete process.env.SMS_ENABLED; else process.env.SMS_ENABLED = oldEnabled;
    if (oldProvider === undefined) delete process.env.SMS_PROVIDER; else process.env.SMS_PROVIDER = oldProvider;
  }
});
