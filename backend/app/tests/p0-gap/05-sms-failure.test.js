// 测试 5/9：短信失败不影响收银 —— 交易仍成功，失败记录进 SmsNotification 台账，状态与 attemptCount 正确
// 另覆盖 AC-05/AC-06：八态、SIMULATED 不得显示为已送达、回执状态机、回调幂等、台账手机号脱敏
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  prisma, createScope, P0_GAP_POLICIES, getSmsRuntimeConfig,
  queueConsumptionSms, dispatchSmsNotification, applyReceipt, SmsReceiptError, ROLES,
  post, get, tokenFor, DEMO, waitFor, dec,
} from './_helpers.js';

const scope = createScope('p05');
const adminToken = tokenFor('ADMIN');
let memberId;
let memberPhone;
let checkout = null;

before(async () => {
  await scope.cleanup();
  memberPhone = scope.qaPhone();
  const m = await prisma.member.create({ data: {
    id: scope.key('member'), phone: memberPhone, name: 'QA-短信失败',
    status: 'ACTIVE', smsNotificationEnabled: true,
  } });
  memberId = m.id;
});
after(async () => { await scope.cleanup(); await prisma.$disconnect(); });

async function makeQaTransaction(tag) {
  return prisma.transaction.create({ data: {
    id: scope.key('tx'), memberId, customerName: scope.key('txname'),
    totalAmount: '10.00', actualPaidAmount: '10.00', discountAmount: '0.00',
    paymentMethod: 'CASH', transactionType: 'NORMAL',
    transactionTime: new Date(), notes: `qa-p05-${tag}`,
  } });
}
async function makeSms({ status, provider = 'mock', providerRequestId = null, attemptCount = 0 }) {
  const tx = await makeQaTransaction('sms-ledger');
  return prisma.smsNotification.create({ data: {
    transactionId: tx.id, memberId,
    phoneLast4: memberPhone.slice(-4),
    status, provider, amount: '10.00', balanceAfter: '0.00',
    occurredAt: new Date(), messagePreview: 'QA 短信台账',
    templateParams: { time: '11-11 10:00', amount: '10.00', balance: '0.00' },
    providerRequestId, attemptCount,
  } });
}

describe('AC-05/AC-06 短信失败不影响收银 + 八态回执', () => {
  test('真实收银：交易 200、outbox 与交易同事务落库、台账状态合法且手机号脱敏', async () => {
    const r = await post('/api/transactions', { token: adminToken, body: {
      memberId, customerName: scope.key('txname'),
      serviceIds: [DEMO.service2Id], paymentMethod: 'CASH',
      notes: 'qa-p05-real-checkout',
    } });
    assert.equal(r.status, 200, `收银必须成功: ${r.status} ${r.text}`);
    const txId = r.json.id;
    assert.ok(r.json.smsNotification?.id, '收银响应应带出 outbox 记录 id');
    assert.equal(await prisma.transaction.count({ where: { id: txId } }), 1, '交易必须落库');

    const row = await waitFor(async () => {
      const x = await prisma.smsNotification.findUnique({ where: { transactionId: txId } });
      return x && !['PENDING', 'SENDING'].includes(x.status) ? x : null;
    });
    assert.ok(row, 'SmsNotification 台账必须存在并被异步派发');
    assert.ok(P0_GAP_POLICIES.SMS_ALLOWED_STATUSES.includes(row.status),
      `台账状态必须在八态白名单内: ${row.status}`);
    // mock 通道只允许 SIMULATED，绝不产生 DELIVERED
    assert.notEqual(row.status, 'DELIVERED', 'mock 模拟记录不得标记为已送达');
    assert.equal(row.status, 'SIMULATED');
    assert.equal(row.providerCode, 'MOCK_OK');
    assert.equal(row.providerRequestId, `mock-${row.id}`);
    assert.equal(row.attemptCount, 1);
    assert.equal(row.phoneLast4, memberPhone.slice(-4));
    assert.equal(row.memberId, memberId);
    assert.ok(!row.messagePreview.includes(memberPhone), '台账不得保存完整手机号');
    checkout = { txId, smsId: row.id, paidAmount: r.json.actualPaidAmount };
  });

  test('模拟短信发送失败：收银交易不受影响，台账 FAILED 且 attemptCount=1、错误信息留痕', async () => {
    assert.ok(checkout, '依赖上一条真实收银用例');
    const before = await prisma.transaction.findUnique({ where: { id: checkout.txId } });
    assert.ok(before, '收银交易必须仍然存在');

    // 注入一个不支持的通道，把已派发的台账重置为可重试态
    await prisma.smsNotification.update({
      where: { id: checkout.smsId },
      data: {
        provider: 'qa-broken', status: 'FAILED', attemptCount: 0,
        nextAttemptAt: new Date(Date.now() + 3600000), errorMessage: null,
      },
    });
    const savedProvider = process.env.SMS_PROVIDER;
    process.env.SMS_PROVIDER = 'qa-broken';
    try {
      const failed = await dispatchSmsNotification(checkout.smsId, { force: true });
      assert.equal(failed.status, 'FAILED', `发送失败应落 FAILED: ${failed.status}`);
      assert.equal(failed.attemptCount, 1, 'attemptCount 应准确递增 1 次');
      assert.match(failed.errorMessage || '', /不支持的短信通道/, '失败原因必须脱敏留痕');
      assert.ok(failed.nextAttemptAt instanceof Date, '应安排退避重试');
    } finally {
      process.env.SMS_PROVIDER = savedProvider;
    }

    const after = await prisma.transaction.findUnique({ where: { id: checkout.txId } });
    assert.ok(after, '短信发送失败后，收银交易绝不能被回滚或删除');
    assert.equal(dec(after.actualPaidAmount).toFixed(2), dec(before.actualPaidAmount).toFixed(2));
    assert.equal(await prisma.smsNotification.count({ where: { transactionId: checkout.txId } }), 1,
      '失败记录必须留在台账中，不得丢失');
  });

  test('八态白名单 / 运行时配置 / 台账脱敏 / 重试与回调权限双层', async () => {
    assert.deepEqual(
      [...P0_GAP_POLICIES.SMS_ALLOWED_STATUSES],
      ['PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'REJECTED', 'SIMULATED', 'FAILED', 'SKIPPED'],
    );
    const cfg = getSmsRuntimeConfig();
    assert.equal(cfg.receiptCallbackEnabled, false);
    assert.equal(cfg.isSimulation, true);
    assert.equal(P0_GAP_POLICIES.SMS_RECEIPT_CALLBACK_ENABLED, false);
    assert.equal(P0_GAP_POLICIES.SMS_ACCEPTED_STATUS, 'ACCEPTED');
    assert.equal(P0_GAP_POLICIES.SMS_SIMULATED_STATUS, 'SIMULATED');

    const c = await get('/api/sms-notifications/config', { token: adminToken });
    assert.equal(c.status, 200);
    assert.equal(c.json.receiptCallbackEnabled, false);
    assert.ok(!/(SECRET|SECRETKEY|PASSWORD|TOKEN)/i.test(c.text), '配置响应不得泄露任何密钥');

    for (const status of ['DELIVERED', 'REJECTED', 'SIMULATED', 'FAILED']) {
      const ok = await get('/api/sms-notifications', { token: adminToken, query: { status, limit: 100 } });
      assert.equal(ok.status, 200, `合法状态 ${status} 应 200: ${ok.status} ${ok.text}`);
      assert.equal(ok.json.page, 1);
      assert.ok(Array.isArray(ok.json.data));
      assert.ok(ok.json.counts && typeof ok.json.counts === 'object');
    }
    const badStatus = await get('/api/sms-notifications', { token: adminToken, query: { status: 'NOT_A_STATUS' } });
    assert.equal(badStatus.status, 400, `非法状态应 400: ${badStatus.status} ${badStatus.text}`);

    const list = await get('/api/sms-notifications', { token: adminToken, query: { limit: 100 } });
    const qaRow = list.json.data.find(x => x.id === checkout.smsId);
    assert.ok(qaRow, '应能在台账中查到 QA 记录');
    assert.equal(qaRow.phoneMasked, `*******${memberPhone.slice(-4)}`);
    assert.equal(qaRow.phoneLast4, undefined, '不得回传 phoneLast4 原文');
    assert.ok(!list.text.includes(memberPhone), '台账响应不得包含完整手机号');
    assert.match(qaRow.amount, /^\d+\.\d{2}$/);
    assert.match(qaRow.balanceAfter, /^\d+\.\d{2}$/);

    for (const role of ['STYLIST', 'ASSISTANT']) {
      const r = await get('/api/sms-notifications', { token: tokenFor(role) });
      assert.equal(r.status, 403, `${role} 访问短信台账应 403: ${r.status} ${r.text}`);
    }
    assert.equal((await get('/api/sms-notifications')).status, 401);

    // retry 仅对 FAILED / PENDING 开放
    const simulated = await makeSms({ status: 'SIMULATED', providerRequestId: `mock-${scope.key('rid')}` });
    const retry = await post(`/api/sms-notifications/${simulated.id}/retry`, { token: adminToken });
    assert.equal(retry.status, 409, `SIMULATED 不得重试: ${retry.status} ${retry.text}`);

    // 回执回调默认关闭：401 / 403 / 404 顺序
    const cb = '/api/sms-notifications/receipts/callback';
    const body = { providerRequestId: 'qa-no-such-rid', terminalStatus: 'DELIVERED' };
    assert.equal((await post(cb, { body })).status, 401);
    for (const role of ['STYLIST', 'ASSISTANT']) {
      const r = await post(cb, { token: tokenFor(role), body });
      assert.equal(r.status, 403, `${role} 回调应 403: ${r.status} ${r.text}`);
    }
    for (const role of ['ADMIN', 'MANAGER']) {
      const r = await post(cb, { token: tokenFor(role), body });
      assert.equal(r.status, 404, `${role} 在默认关闭时应 404: ${r.status} ${r.text}`);
      assert.match(r.text, /未启用/);
    }
  });

  test('回执状态机 applyReceipt：ACCEPTED→DELIVERED/REJECTED、终态幂等、SIMULATED 拒绝、文本脱敏', async () => {
    // ACCEPTED → DELIVERED，重复回调 no-op
    const rid1 = scope.key('rid-delivered');
    const s1 = await makeSms({ status: 'ACCEPTED', providerRequestId: rid1 });
    const d1 = await applyReceipt(rid1, { terminalStatus: 'DELIVERED', receiptRequestId: 'qa-receipt-1' }, ROLES.ADMIN);
    assert.equal(d1.idempotent, false);
    assert.equal(d1.smsNotification.status, 'DELIVERED');
    assert.equal(d1.smsNotification.terminalStatus, 'DELIVERED');
    assert.ok(d1.smsNotification.receiptAt instanceof Date);
    assert.equal(d1.smsNotification.receiptRequestId, 'qa-receipt-1');
    const d2 = await applyReceipt(rid1, { terminalStatus: 'REJECTED' }, ROLES.ADMIN);
    assert.equal(d2.idempotent, true, '终态重复回调必须幂等 no-op');
    assert.equal(d2.smsNotification.status, 'DELIVERED');
    assert.equal((await prisma.smsNotification.findUnique({ where: { id: s1.id } })).rejectCode, null);

    // ACCEPTED → REJECTED，回执文本脱敏（完整手机号 / 凭据片段）
    const rid2 = scope.key('rid-rejected');
    const s2 = await makeSms({ status: 'ACCEPTED', providerRequestId: rid2 });
    const d3 = await applyReceipt(rid2, {
      terminalStatus: 'REJECTED',
      rejectCode: 'AKIDabcdef12345',
      rejectReason: '手机号 13912345678 密钥 SECRETKEYxyz 被运营商退回',
    }, ROLES.ADMIN);
    assert.equal(d3.smsNotification.status, 'REJECTED');
    assert.equal(d3.smsNotification.terminalStatus, 'REJECTED');
    assert.ok(!/13912345678/.test(d3.smsNotification.rejectReason), '完整手机号必须脱敏');
    assert.ok(!/AKIDabcdef12345|SECRETKEYxyz/.test(d3.smsNotification.rejectReason), '凭据片段必须脱敏');
    assert.ok(!/AKIDabcdef12345/.test(d3.smsNotification.rejectCode));
    assert.match(d3.smsNotification.rejectReason, /\*{4}|\[REDACTED\]/);

    // SIMULATED 不得被登记为已送达
    const rid3 = scope.key('rid-simulated');
    const s3 = await makeSms({ status: 'SIMULATED', providerRequestId: rid3 });
    await assert.rejects(
      () => applyReceipt(rid3, { terminalStatus: 'DELIVERED' }, ROLES.ADMIN),
      (e) => e instanceof SmsReceiptError && e.statusCode === 409,
    );
    const s3after = await prisma.smsNotification.findUnique({ where: { id: s3.id } });
    assert.equal(s3after.status, 'SIMULATED');
    assert.equal(s3after.terminalStatus, null);
    assert.equal(s3after.receiptAt, null);

    // 其它边界：缺少 providerRequestId → 400；查无记录 → null
    await assert.rejects(
      () => applyReceipt('', { terminalStatus: 'DELIVERED' }, ROLES.ADMIN),
      (e) => e instanceof SmsReceiptError && e.statusCode === 400 && /providerRequestId/.test(e.message),
    );
    assert.equal(await applyReceipt('qa-unknown-rid-xyz', { terminalStatus: 'DELIVERED' }, ROLES.ADMIN), null);
    const rid4 = scope.key('rid-sending');
    await makeSms({ status: 'SENDING', providerRequestId: rid4 });
    await assert.rejects(
      () => applyReceipt(rid4, { terminalStatus: 'DELIVERED' }, ROLES.ADMIN),
      (e) => e instanceof SmsReceiptError && e.statusCode === 409,
    );
    await assert.rejects(
      () => applyReceipt(rid4, { terminalStatus: 'ACCEPTED' }, ROLES.ADMIN),
      (e) => e instanceof SmsReceiptError && e.statusCode === 400,
    );
  });

  test('mock 派发只写 SIMULATED，不伪造 DELIVERED；SKIPPED 手机号无效不进发送队列', async () => {
    const pending = await makeSms({ status: 'PENDING' });
    const out = await dispatchSmsNotification(pending.id);
    assert.equal(out.status, 'SIMULATED');
    assert.equal(out.providerCode, 'MOCK_OK');
    assert.equal(out.attemptCount, 1);
    assert.notEqual(out.status, 'DELIVERED');

    const invalidPhoneMember = await prisma.member.create({ data: {
      id: scope.key('member-badphone'), phone: 'qa-invalid', name: 'QA-无效手机号',
      status: 'ACTIVE', smsNotificationEnabled: true,
    } });
    const tx = await prisma.transaction.create({ data: {
      id: scope.key('tx'), memberId: invalidPhoneMember.id,
      customerName: scope.key('txname'), totalAmount: '10.00', actualPaidAmount: '10.00',
      discountAmount: '0.00', paymentMethod: 'CASH', transactionType: 'NORMAL',
      transactionTime: new Date(), notes: 'qa-p05-invalid-phone',
    } });
    // queueConsumptionSms 对无效手机号直接写 SKIPPED
    const skipped = await queueConsumptionSms(prisma, tx);
    assert.ok(skipped, '无效手机号也应留台账');
    assert.equal(skipped.status, 'SKIPPED');
    assert.match(skipped.errorMessage || '', /手机号格式无效/);
  });
});
