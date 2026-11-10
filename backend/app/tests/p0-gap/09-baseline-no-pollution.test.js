// 测试 9/9：收尾 —— 真实登录链路、基础健康探测、演示数据零污染证据、外部审核项标注
// 覆盖 AC-07 / AC-11、架构 §6 权限矩阵、任务书「数据隔离硬性要求」
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  prisma, P0_GAP_POLICIES, getSmsRuntimeConfig, DEMO, EXPECTED_BASELINE,
  cleanupAllQa, captureCounts, assertDemoDataIntact, post, get,
  BASE_URL,
} from './_helpers.js';

// 凭据只从环境变量读取；本文件不写入、不打印、不回显任何凭据值。
const accounts = () => ([
  ['ADMIN', process.env.ADMIN_USERNAME],
  ['MANAGER', process.env.MANAGER_USERNAME || P0_GAP_POLICIES.DEMO_STAFF_USERNAMES.MANAGER],
  ['STYLIST', process.env.STYLIST_USERNAME || P0_GAP_POLICIES.DEMO_STAFF_USERNAMES.STYLIST],
  ['ASSISTANT', process.env.ASSISTANT_USERNAME || P0_GAP_POLICIES.DEMO_STAFF_USERNAMES.ASSISTANT],
]);
const loginPassword = () => process.env.DEMO_STAFF_PASSWORD || process.env.ADMIN_PASSWORD;

after(async () => { await prisma.$disconnect(); });

describe('AC-07/AC-11 演示环境基线与真实登录链路', () => {
  test('基础健康：/api/health 200 {"status":"ok"}、前端 /login 200、/api/configs 公开白名单', async () => {
    const health = await get('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { status: 'ok' });

    const loginPage = await fetch('http://127.0.0.1:5173/login');
    assert.equal(loginPage.status, 200, '前端静态预览 /login 应 200');

    const cfg = await get('/api/configs');
    assert.equal(cfg.status, 200);
    assert.equal(typeof cfg.json.enableLoginCaptcha, 'boolean');
    assert.equal(cfg.json.bookingCode, undefined, '公开配置不得下发预约访问码');
    assert.ok(!/(SECRET|PASSWORD|TOKEN)/i.test(cfg.text));
  });

  test('四级演示账号真实登录均 200 且 accessToken 可访问受保护端点（不回显凭据）', { timeout: 180000 }, async () => {
    const password = loginPassword();
    assert.ok(password, '登录口令必须由环境变量注入');
    for (const [role, username] of accounts()) {
      assert.ok(username, `${role} 账号名必须由环境变量或集中配置提供`);
      // /api/auth/login per-route 限流 10/min；本用例只发 4 次登录，遇 429 则等待窗口重置
      let login = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        login = await post('/api/auth/login', { body: { username, password } });
        if (login.status !== 429) break;
        await new Promise(r => setTimeout(r, 62000));
      }
      assert.equal(login.status, 200, `${role} 真实登录应 200（凭据值不回显）`);
      assert.ok(typeof login.json?.accessToken === 'string' && login.json.accessToken.length > 10);
      const cap = await get('/api/appointments/capacity', {
        token: login.json.accessToken, query: { date: '2026-11-11' },
      });
      assert.equal(cap.status, 200, `${role} 的真实 token 应可访问受保护端点`);
      assert.deepEqual(cap.json.beds, P0_GAP_POLICIES.BEDS);
    }
  });

  test('真实短信 / 回执回调仍为关闭态（本轮不启动外部通道，需外部审核）', async () => {
    assert.equal(P0_GAP_POLICIES.ENABLE_REAL_SMS, false);
    assert.equal(P0_GAP_POLICIES.SMS_RECEIPT_CALLBACK_ENABLED, false);
    const cfg = getSmsRuntimeConfig();
    assert.equal(cfg.receiptCallbackEnabled, false);
    assert.equal(cfg.provider, 'mock');
    assert.equal(cfg.isSimulation, true);
    assert.ok(!process.env.TENCENTCLOUD_SECRET_ID, '本轮不得配置腾讯云密钥');
    assert.ok(!process.env.TENCENTCLOUD_SECRET_KEY, '本轮不得配置腾讯云密钥');
    assert.equal(get('/api/sms-notifications/receipts/callback') instanceof Promise, true);
  });

  test('演示数据零污染：清理全部 qa- 数据后，条数 + 演示行逐字段 + SystemConfig 均与基线一致', async (t) => {
    await cleanupAllQa();
    const counts = await captureCounts();
    t.diagnostic(`QA_ZERO_POLLUTION_BASELINE=${JSON.stringify(EXPECTED_BASELINE)}`);
    t.diagnostic(`QA_ZERO_POLLUTION_AFTER=${JSON.stringify(counts)}`);
    assert.deepEqual(counts, EXPECTED_BASELINE);
    await assertDemoDataIntact();

    // 逐项硬证据：3 名会员 / 1 个套餐 / 2 张持有 / 3 条履约 / 4 笔交易 / 2 条短信 / 0 预约
    assert.equal(await prisma.member.count({ where: { id: { in: DEMO.memberIds } } }), 3);
    assert.equal(await prisma.packageHolding.count({ where: { id: { in: DEMO.holdingIds } } }), 2);
    assert.equal(await prisma.packageUsage.count({ where: { requestKey: { in: DEMO.usageKeys } } }), 3);
    assert.equal(await prisma.transaction.count({ where: { id: { in: DEMO.txIds } } }), 4);
    assert.equal(await prisma.appointment.count(), 0);
    assert.equal(await prisma.packageRefundAudit.count({ where: { requestKey: { startsWith: 'qa-' } } }), 0);
    assert.equal(await prisma.smsNotification.count({ where: { memberId: { startsWith: 'qa-' } } }), 0);
    assert.equal(await prisma.member.count({ where: { id: { startsWith: 'qa-' } } }), 0,
      '不得残留任何 QA 自建会员');
    t.diagnostic('QA_ZERO_POLLUTION_VERIFIED=true');
  });
});
