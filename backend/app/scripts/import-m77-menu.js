import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-11-20 门店经营者确认的套餐。来源与原文见项目根目录 docs/参考资料/。
// 一项组合套餐整体算一次服务；本次标准价暂用套餐价，且均长期有效。
export const MENU = Object.freeze([
  { name: '大白肌', price: '99.00', uses: 3 },
  { name: '水氧焕肤', price: '108.00', uses: 1 },
  { name: '低感清洁', price: '128.00', uses: 1 },
  { name: '肤色管理（VIP专享）', price: '980.00', uses: 1 },
  { name: '痘肌平衡修复+黑头粉刺大扫除', price: '368.00', uses: 3 },
  { name: '敏感肌屏障修复', price: '108.00', uses: 1 },
  { name: '肤色管理（年度VIP专享）', price: '3980.00', uses: 1 },
  { name: '面部护理（1V1量肤定制）', price: '1980.00', uses: 1 },
  { name: '肤质管理（年度VIP专享）', price: '4980.00', uses: 1 },
  { name: '奢养护理卡（面部肤色+肤质）量肤定制', price: '596.00', uses: 3 },
  { name: '婴儿肌（肤质管理）', price: '199.00', uses: 1 },
  { name: '（新客推荐）王牌项目3个', price: '298.00', uses: 3 },
]);

const money = (value) => Number(value).toFixed(2);
const serviceId = (index) => `m77menu-svc-${String(index + 1).padStart(2, '0')}`;
const planId = (index) => `m77menu-plan-${String(index + 1).padStart(2, '0')}`;

export function planImport(services, plans) {
  if (MENU.length !== 12 || new Set(MENU.map((row) => row.name)).size !== MENU.length) {
    throw new Error('套餐清单必须为 12 个不同名称');
  }
  const serviceByName = new Map(services.map((row) => [row.name, row]));
  const serviceById = new Map(services.map((row) => [row.id, row]));
  const planById = new Map(plans.map((row) => [row.id, row]));
  const planByName = new Map();
  for (const row of plans) {
    if (!planByName.has(row.name)) planByName.set(row.name, []);
    planByName.get(row.name).push(row);
  }

  return MENU.map((item, index) => {
    const id = serviceId(index);
    const namedService = serviceByName.get(item.name);
    const identifiedService = serviceById.get(id);
    if (namedService && identifiedService && namedService.id !== identifiedService.id) {
      throw new Error(`服务项目 ID 与名称分别对应不同记录：${item.name}`);
    }
    const existingService = namedService || identifiedService;
    if (existingService && (existingService.name !== item.name || money(existingService.standardPrice) !== item.price || existingService.status !== 'AVAILABLE')) {
      throw new Error(`服务项目冲突：${item.name}。请人工核对已有名称、价格和上下架状态`);
    }
    const targetServiceId = existingService?.id || id;
    const desiredPlanId = planId(index);
    const sameNamePlans = planByName.get(item.name) || [];
    const existingPlan = planById.get(desiredPlanId) || sameNamePlans[0];
    if (sameNamePlans.length > 1 || (existingPlan && (
      existingPlan.name !== item.name || existingPlan.serviceId !== targetServiceId
      || money(existingPlan.price) !== item.price || existingPlan.totalUses !== item.uses
      || existingPlan.validDays !== null || existingPlan.active !== true
    ))) {
      throw new Error(`套餐冲突：${item.name}。请人工核对已有名称、价格、次数和有效期`);
    }
    if (existingPlan && planById.has(desiredPlanId) && sameNamePlans.length && sameNamePlans[0].id !== desiredPlanId) {
      throw new Error(`套餐 ID 与名称分别对应不同记录：${item.name}`);
    }
    return {
      index: index + 1, ...item,
      serviceId: targetServiceId, serviceAction: existingService ? 'reuse' : 'create',
      planId: existingPlan?.id || desiredPlanId, planAction: existingPlan ? 'reuse' : 'create',
    };
  });
}

export async function importMenu(db, apply = false) {
  const execute = async (tx) => {
    const owner = await tx.user.findUnique({ where: { username: process.env.ADMIN_USERNAME } });
    if (!owner || owner.role !== 'ADMIN') throw new Error('未找到配置的老板账号');
    const [services, plans] = await Promise.all([tx.service.findMany(), tx.packagePlan.findMany()]);
    const rows = planImport(services, plans);
    if (apply) {
      for (const row of rows) {
        if (row.serviceAction === 'create') {
          await tx.service.create({ data: {
            id: row.serviceId, name: row.name, standardPrice: row.price,
            status: 'AVAILABLE', sortOrder: row.index, noDiscount: false,
          } });
        }
        if (row.planAction === 'create') {
          await tx.packagePlan.create({ data: {
            id: row.planId, name: row.name, serviceId: row.serviceId,
            totalUses: row.uses, price: row.price, validDays: null,
            active: true, createdBy: owner.id,
          } });
        }
      }
    }
    return rows;
  };
  return apply ? db.$transaction(execute) : execute(db);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('用法：node --import tsx scripts/import-m77-menu.js [--dry-run|--apply]');
  }
  const prisma = (await import('../src/db/prisma.js')).default;
  try {
    const apply = args.includes('--apply');
    const rows = await importMenu(prisma, apply);
    for (const row of rows) console.log(`${String(row.index).padStart(2, '0')} ${row.name} ¥${row.price} ${row.uses}次 服务:${row.serviceAction} 套餐:${row.planAction}`);
    console.log(`${apply ? '已写入' : '预演'} ${rows.length} 项`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
