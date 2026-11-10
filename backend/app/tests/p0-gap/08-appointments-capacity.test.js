// 测试 8/9：预约三字段、床位×时段容量、同床位冲突、既有 ±1h 检测不回归、旧记录「未标注」
// 覆盖 AC-08/AC-11、routes/appointments.js、routes/booking.js、utils/bookingCapacity.js
import fs from 'node:fs';
import path from 'node:path';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  prisma, createScope, computeDailyCapacity, assertNoBedConflict, BedConflictError,
  P0_GAP_POLICIES, buildSlotGrid, PROJECT_ROOT,
  post, get, patch, tokenFor, snapshotConfig, restoreConfig, qaPhone,
} from './_helpers.js';

const scope = createScope('p08');
const adminToken = tokenFor('ADMIN');
const DATE = '2026-12-15';
// 容量测试使用独立日期，避免被其它用例在同一时段创建的预约干扰
const CAP_DATE = '2026-12-20';
const CAP_T1 = '2026-12-20T10:00:00+08:00';
const T1 = '2026-12-15T10:00:00+08:00'; // slot 10:00
const T2 = '2026-12-15T10:30:00+08:00'; // slot 10:30，落在 T1 ±1h 内
const T3 = '2026-12-15T14:00:00+08:00'; // slot 14:00
const T4 = '2026-12-15T16:00:00+08:00'; // slot 16:00
const T5 = '2026-12-15T18:00:00+08:00'; // slot 18:00
const phoneMarker = () => `qa${Buffer.from(Math.random().toString(36).slice(2, 10)).toString('hex').slice(0, 8)}`;
let memberId;
let bookingCode;
let configSnapshot;
let DEMO_SERVICE = 'svc00002';
let DEMO_STAFF = 'staff001';

before(async () => {
  await scope.cleanup();
  const m = await prisma.member.create({ data: {
    id: scope.key('member'), phone: qaPhone(), name: 'QA-预约容量', status: 'ACTIVE',
  } });
  memberId = m.id;
  configSnapshot = await snapshotConfig();
  bookingCode = `qa_p08_code_${scope.prefix.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 8)}`;
  await prisma.systemConfig.update({ where: { id: 1 }, data: { bookingCode } });
});
after(async () => {
  await restoreConfig(configSnapshot);
  await scope.cleanup();
  await prisma.$disconnect();
});

const apptBody = (overrides = {}) => ({
  customerName: scope.key('appt'), customerPhone: phoneMarker(),
  appointmentTime: T1, serviceIds: [DEMO_SERVICE],
  ...overrides,
});
const bookingBody = (phone, time, overrides = {}) => ({
  customerName: scope.key('booking'), customerPhone: phone,
  appointmentTime: time, serviceIds: [DEMO_SERVICE],
  ...overrides,
});

describe('AC-08 预约新字段与床位×时段容量', () => {
  test('POST /api/appointments 新老客 / 来源渠道 / 床位三字段落库，GET 可回读', async () => {
    const body = apptBody({ customerType: 'NEW', sourceChannel: 'DOUYIN', bedId: 'B1' });
    const r = await post('/api/appointments', { token: adminToken, body });
    assert.equal(r.status, 200, `新增预约应成功: ${r.status} ${r.text}`);
    assert.equal(r.json.customerType, 'NEW');
    assert.equal(r.json.sourceChannel, 'DOUYIN');
    assert.equal(r.json.bedId, 'B1');
    const row = await prisma.appointment.findUnique({ where: { id: r.json.id } });
    assert.equal(row.customerType, 'NEW');
    assert.equal(row.sourceChannel, 'DOUYIN');
    assert.equal(row.bedId, 'B1');
    assert.equal(row.status, 'PENDING');

    const list = await get('/api/appointments', {
      token: adminToken, query: { startDate: '2026-12-01', endDate: '2026-12-31' },
    });
    assert.equal(list.status, 200);
    assert.ok(list.json.some(a => a.id === row.id), 'GET 应能回读新预约');
  });

  test('枚举边界：无效床位 / 渠道 / 新老客 → 400；多余字段被剥离；服务层床位编码校验 400', async () => {
    for (const [label, patch] of [
      ['床位', { bedId: 'B9' }],
      ['渠道', { sourceChannel: 'NOT_A_CHANNEL' }],
      ['新老客', { customerType: 'VIP' }],
    ]) {
      const r = await post('/api/appointments', { token: adminToken, body: apptBody(patch) });
      assert.equal(r.status, 400, `${label} 非法应 400: ${r.status} ${r.text}`);
    }
    // Fastify 默认 Ajv `removeAdditional:true`：additionalProperties:false 会剥离多余字段而非报 400。
    // 这正是架构陷阱 T-01 的由来（新字段必须在白名单里声明，否则会被静默丢弃）。
    const extra = await post('/api/appointments', {
      token: adminToken, body: apptBody({ unexpectedField: 1 }),
    });
    assert.equal(extra.status, 200, `多余字段应被剥离而非拒绝: ${extra.status} ${extra.text}`);
    assert.equal(extra.json.unexpectedField, undefined, '多余字段不得落库或回传');

    await assert.rejects(
      () => assertNoBedConflict(prisma, 'B9', { start: new Date(T1), end: new Date(T2) }),
      (e) => e instanceof BedConflictError && e.statusCode === 400,
    );
    // 空 bedId 不参与冲突（公开预约留空由店长补录）
    await assert.doesNotReject(() => assertNoBedConflict(prisma, null, { start: new Date(T1), end: new Date(T2) }));
  });

  test('容量 = 床位 × 时段：28 个时段、4 床位；占用后 available/freeBeds 正确；不泄露手机号', async () => {
    const empty = await get('/api/appointments/capacity', { token: adminToken, query: { date: CAP_DATE } });
    assert.equal(empty.status, 200);
    const cap = empty.json;
    assert.equal(cap.date, CAP_DATE);
    assert.deepEqual(cap.beds, ['B1', 'B2', 'B3', 'B4']);
    assert.equal(cap.capacityBasis, 'BEDS_X_SLOTS');
    assert.equal(cap.slots.length, 28);
    assert.equal(buildSlotGrid().length, 28);
    for (const s of cap.slots) {
      assert.equal(s.total, P0_GAP_POLICIES.BEDS.length);
      assert.equal(s.available, Math.max(0, s.total - s.occupied));
      assert.equal(s.occupied, 0, '独立日期初始应无占用');
      assert.deepEqual(Object.keys(s).sort(),
        ['slot', 'label', 'total', 'occupied', 'available', 'freeBeds'].sort(),
        '容量端点只返回聚合占用数，不得含会员手机号/完整经营数据');
    }

    // 在 CAP_DATE 10:00 时段占用 B1 / B2
    const a1 = await post('/api/appointments', { token: adminToken, body: apptBody({ bedId: 'B1', appointmentTime: CAP_T1 }) });
    const a2 = await post('/api/appointments', { token: adminToken, body: apptBody({ bedId: 'B2', appointmentTime: CAP_T1 }) });
    assert.equal(a1.status, 200, `占用 B1 应成功: ${a1.status} ${a1.text}`);
    assert.equal(a2.status, 200, `占用 B2 应成功: ${a2.status} ${a2.text}`);

    const after = await get('/api/appointments/capacity', { token: adminToken, query: { date: CAP_DATE } });
    const slot10 = after.json.slots.find(s => s.slot === '10:00');
    assert.equal(slot10.occupied, 2);
    assert.equal(slot10.available, 2);
    assert.deepEqual(slot10.freeBeds, ['B3', 'B4']);
    const slot14 = after.json.slots.find(s => s.slot === '14:00');
    assert.equal(slot14.occupied, 0, '其它时段不得被误占用');
    assert.equal(slot14.available, 4);

    // 服务层同口径复核
    const svcCap = await computeDailyCapacity(CAP_DATE, prisma);
    assert.equal(svcCap.slots.find(s => s.slot === '10:00').occupied, 2);
  });

  test('同床位同时段（±1h）重复预约被拒 409；空 bedId 不冲突', async () => {
    const first = await post('/api/appointments', {
      token: adminToken, body: apptBody({ bedId: 'B3', appointmentTime: T4 }),
    });
    assert.equal(first.status, 200, `首次占用应成功: ${first.status} ${first.text}`);
    const dup = await post('/api/appointments', {
      token: adminToken, body: apptBody({ bedId: 'B3', appointmentTime: '2026-12-15T16:30:00+08:00' }),
    });
    assert.equal(dup.status, 409, `同床位 ±1h 应 409: ${dup.status} ${dup.text}`);
    assert.match(dup.text, /床位在此时段已被占用/);
    const noBed = await post('/api/appointments', {
      token: adminToken, body: apptBody({ bedId: null, appointmentTime: T4 }),
    });
    assert.equal(noBed.status, 200, `空 bedId 不参与冲突: ${noBed.status} ${noBed.text}`);
  });

  test('旧记录三字段为 NULL：后端 GET 不报错；前端常量与构建产物均含「未标注」', async () => {
    const old = await post('/api/appointments', {
      token: adminToken, body: apptBody({ appointmentTime: T5, customerType: null, sourceChannel: null, bedId: null }),
    });
    assert.equal(old.status, 200, `旧式记录应可创建: ${old.status} ${old.text}`);
    assert.equal(old.json.customerType, null);
    assert.equal(old.json.sourceChannel, null);
    assert.equal(old.json.bedId, null);
    const list = await get('/api/appointments', {
      token: adminToken, query: { startDate: '2026-12-01', endDate: '2026-12-31' },
    });
    assert.equal(list.status, 200, '含 NULL 新字段的旧记录不得导致列表接口报错');
    assert.ok(list.json.some(a => a.id === old.json.id && a.customerType === null));

    const constants = fs.readFileSync(
      path.join(PROJECT_ROOT, 'frontend/app/src/constants/p0Gap.js'), 'utf8');
    assert.match(constants, /UNLABELLED_TEXT\s*=\s*'未标注'/, '前端常量必须定义「未标注」');
    assert.match(constants, /SIMULATED[\s\S]{0,120}模拟成功（未送达）/,
      'SIMULATED 标签必须是「模拟成功（未送达）」，不得显示为已送达');
    const view = fs.readFileSync(
      path.join(PROJECT_ROOT, 'frontend/app/src/views/AppointmentView.vue'), 'utf8');
    assert.match(view, /未标注/, '旧记录三字段需有「未标注」兜底展示');

    const distDir = path.join(PROJECT_ROOT, 'frontend/app/dist/js');
    const built = fs.readdirSync(distDir).filter(f => /^p0Gap-.*\.js$/.test(f));
    assert.ok(built.length >= 1, '应存在已构建的 p0Gap 产物');
    const builtText = built.map(f => fs.readFileSync(path.join(distDir, f), 'utf8')).join('\n');
    assert.match(builtText, /未标注/, '构建产物必须实际包含「未标注」文案');
    assert.match(builtText, /模拟成功（未送达）/, '构建产物必须实际包含 SIMULATED 正确文案');
  });
});

describe('AC-08 公开预约：既有 ±1h 冲突检测不回归 + 床位冲突 + 配置权限', () => {
  test('/options 返回 beds 与 capacity（28 时段）；错误 code → 404', async () => {
    const ok = await get('/api/public/booking/options', { query: { code: bookingCode, date: DATE } });
    assert.equal(ok.status, 200, `带日期的 options 应 200: ${ok.status} ${ok.text}`);
    assert.deepEqual(ok.json.beds, ['B1', 'B2', 'B3', 'B4']);
    assert.equal(ok.json.capacity.slots.length, 28);
    assert.ok(Array.isArray(ok.json.services) && Array.isArray(ok.json.staff));
    const bad = await get('/api/public/booking/options', { query: { code: 'wrong_code_xyz', date: DATE } });
    assert.equal(bad.status, 404);
    const postBad = await post('/api/public/booking', {
      query: { code: 'wrong_code_xyz' }, body: bookingBody(qaPhone(), T5),
    });
    assert.equal(postBad.status, 404);
  });

  test('同手机号 ±1h 冲突仍生效（409）', async () => {
    const phone = qaPhone();
    const seed = await post('/api/appointments', {
      token: adminToken, body: apptBody({ customerPhone: phone, appointmentTime: T3 }),
    });
    assert.equal(seed.status, 200);
    const dup = await post('/api/public/booking', {
      query: { code: bookingCode },
      body: bookingBody(phone, '2026-12-15T14:30:00+08:00'),
    });
    assert.equal(dup.status, 409, `同手机号 ±1h 应 409: ${dup.status} ${dup.text}`);
    assert.match(dup.text, /您在该时段已有预约/);
  });

  test('同员工 ±1h 冲突仍生效（409）', async () => {
    const seed = await post('/api/appointments', {
      token: adminToken, body: apptBody({ assignedStaffId: DEMO_STAFF, appointmentTime: T4 }),
    });
    assert.equal(seed.status, 200);
    const dup = await post('/api/public/booking', {
      query: { code: bookingCode },
      body: bookingBody(qaPhone(), '2026-12-15T16:30:00+08:00', { assignedStaffId: DEMO_STAFF }),
    });
    assert.equal(dup.status, 409, `同员工 ±1h 应 409: ${dup.status} ${dup.text}`);
    assert.match(dup.text, /该员工在此时段已有预约/);
  });

  test('公开预约新增的床位冲突生效（409）；正常预约成功并返回 appointmentId', async () => {
    const bedSeed = await post('/api/appointments', {
      token: adminToken, body: apptBody({ bedId: 'B4', appointmentTime: T5 }),
    });
    assert.equal(bedSeed.status, 200);
    const dup = await post('/api/public/booking', {
      query: { code: bookingCode },
      body: bookingBody(qaPhone(), '2026-12-15T18:30:00+08:00', { bedId: 'B4' }),
    });
    assert.equal(dup.status, 409, `公开预约床位冲突应 409: ${dup.status} ${dup.text}`);
    assert.match(dup.text, /床位在此时段已被占用/);

    const freshPhone = qaPhone();
    const ok = await post('/api/public/booking', {
      query: { code: bookingCode },
      body: bookingBody(freshPhone, '2026-12-15T20:00:00+08:00', {
        customerType: 'RETURNING', sourceChannel: 'WALK_IN', bedId: 'B4',
      }),
    });
    assert.equal(ok.status, 200, `正常公开预约应成功: ${ok.status} ${ok.text}`);
    assert.equal(ok.json.success, true);
    assert.ok(ok.json.appointmentId);
    const row = await prisma.appointment.findUnique({ where: { id: ok.json.appointmentId } });
    assert.equal(row.customerType, 'RETURNING');
    assert.equal(row.sourceChannel, 'WALK_IN');
    assert.equal(row.bedId, 'B4');
    // 既有 1 分钟同 IP+手机号限流仍生效
    const throttled = await post('/api/public/booking', {
      query: { code: bookingCode },
      body: bookingBody(freshPhone, '2026-12-15T21:00:00+08:00'),
    });
    assert.equal(throttled.status, 429, `二次提交应被限流: ${throttled.status} ${throttled.text}`);
  });

  test('权限：capacity 四级可读 200 / 未认证 401；booking-code 读写仅 ADMIN', async () => {
    for (const role of ['ADMIN', 'MANAGER', 'STYLIST', 'ASSISTANT']) {
      const r = await get('/api/appointments/capacity', { token: tokenFor(role), query: { date: DATE } });
      assert.equal(r.status, 200, `${role} 读 capacity 应 200: ${r.status} ${r.text}`);
    }
    assert.equal((await get('/api/appointments/capacity', { query: { date: DATE } })).status, 401);
    for (const role of ['STYLIST', 'ASSISTANT', 'MANAGER']) {
      const r = await patch('/api/configs/booking-code', {
        token: tokenFor(role), body: { customCode: 'qa_should_fail' },
      });
      assert.equal(r.status, 403, `${role} 改预约访问码应 403: ${r.status} ${r.text}`);
      const g = await get('/api/configs/booking-code', { token: tokenFor(role) });
      assert.equal(g.status, 403);
    }
    const adminRead = await get('/api/configs/booking-code', { token: adminToken });
    assert.equal(adminRead.status, 200);
    assert.equal(adminRead.json.bookingCode, bookingCode);
    // GET /api/configs 公开但只返回白名单字段，不下发 bookingCode
    const publicCfg = await get('/api/configs');
    assert.equal(publicCfg.status, 200);
    assert.equal(publicCfg.json.bookingCode, undefined);
  });
});
