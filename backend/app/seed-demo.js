import 'dotenv/config';
import prisma from './src/db/prisma.js';

async function main() {
  const admin = await prisma.user.findUnique({ where: { username: process.env.ADMIN_USERNAME } });
  if (!admin) throw new Error('请先运行 init-admin.js 创建演示管理员');

  await prisma.systemConfig.upsert({
    where: { id: 1 },
    update: { enableLoginCaptcha: false },
    create: { id: 1, enableLoginCaptcha: false, enableTransactionVoid: false },
  });

  const services = [
    { id: 'svc00001', name: '大白肌护理', standardPrice: '168.00', sortOrder: 1 },
    { id: 'svc00002', name: '低感清洁', standardPrice: '128.00', sortOrder: 2 },
    { id: 'svc00003', name: 'ER屏障护理', standardPrice: '198.00', sortOrder: 3 },
  ];
  for (const item of services) {
    await prisma.service.upsert({
      where: { id: item.id },
      update: { name: item.name, standardPrice: item.standardPrice, status: 'AVAILABLE', sortOrder: item.sortOrder },
      create: { ...item, status: 'AVAILABLE', noDiscount: false },
    });
  }

  const members = [
    { id: 'm7700001', name: '演示顾客·林女士', phone: '13800000001', notes: '演示数据：抖音体验套餐顾客', smsNotificationEnabled: true },
    { id: 'm7700002', name: '演示顾客·周女士', phone: '13800000002', notes: '演示数据：门店自然到店顾客', smsNotificationEnabled: true },
    { id: 'm7700003', name: '演示顾客·陈女士', phone: '13800000003', notes: '演示数据：美团顾客', smsNotificationEnabled: false },
  ];
  for (const item of members) {
    await prisma.member.upsert({
      where: { id: item.id },
      update: { ...item, status: 'ACTIVE' },
      create: { ...item, status: 'ACTIVE', gender: 'FEMALE' },
    });
  }

  const cardType = await prisma.cardType.upsert({
    where: { id: 'cardtype-demo-001' },
    update: { name: '演示500元储值卡', initialPrice: '500.00', discountRate: '1.000', status: 'AVAILABLE' },
    create: { id: 'cardtype-demo-001', name: '演示500元储值卡', initialPrice: '500.00', discountRate: '1.000', status: 'AVAILABLE' },
  });
  await prisma.card.upsert({
    where: { id: 'card-demo-001' },
    // 重新启动演示时不重置余额，保留用户的扣款操作。
    update: { memberId: 'm7700001', cardTypeId: cardType.id },
    create: {
      id: 'card-demo-001', memberId: 'm7700001', cardTypeId: cardType.id,
      balance: '500.00', status: 'ACTIVE', discountSource: 'card_type', isCustomCard: false,
    },
  });

  await prisma.staff.upsert({
    where: { id: 'staff001' },
    update: { name: '演示美容师', position: '美容师', status: 'ACTIVE' },
    create: { id: 'staff001', name: '演示美容师', position: '美容师', status: 'ACTIVE', countsCommission: true, sortOrder: 1 },
  });

  const plan = await prisma.packagePlan.upsert({
    where: { id: 'demo-plan-001' },
    update: { name: '99元大白肌3次体验', serviceId: 'svc00001', totalUses: 3, price: '99.00', validDays: 90, active: true },
    create: { id: 'demo-plan-001', name: '99元大白肌3次体验', serviceId: 'svc00001', totalUses: 3, price: '99.00', validDays: 90, active: true, createdBy: admin.id },
  });

  const purchasedAt = new Date();
  const expiresAt = new Date(purchasedAt.getTime() + 90 * 86400000);
  await prisma.packageHolding.upsert({
    where: { requestKey: 'demo-purchase-0001' },
    update: {},
    create: {
      id: 'demo-holding-001', memberId: 'm7700001', planId: plan.id,
      planName: plan.name, totalUses: 3, remainingUses: 3,
      paidAmount: '99.00', paymentMethod: 'DOUYIN', purchasedAt, expiresAt,
      createdBy: admin.id, createdByName: admin.username, requestKey: 'demo-purchase-0001',
    },
  });

  // 准备一张带扣次和误扣撤销记录的次卡，打开套餐页就能直观看到完整流程。
  const historyHolding = await prisma.packageHolding.upsert({
    where: { requestKey: 'demo-purchase-0002' },
    update: {
      memberId: 'm7700002', planId: plan.id, planName: plan.name,
      totalUses: 3, remainingUses: 1, paidAmount: '99.00', paymentMethod: 'DOUYIN',
      expiresAt, createdBy: admin.id, createdByName: admin.username,
    },
    create: {
      id: 'demo-holding-002', memberId: 'm7700002', planId: plan.id,
      planName: plan.name, totalUses: 3, remainingUses: 1,
      paidAmount: '99.00', paymentMethod: 'DOUYIN', purchasedAt, expiresAt,
      createdBy: admin.id, createdByName: admin.username, requestKey: 'demo-purchase-0002',
    },
  });

  const usageRows = [
    { requestKey: 'demo-redeem-0001', note: '演示正常到店护理', reversed: false },
    { requestKey: 'demo-redeem-0002', note: '演示正常到店护理', reversed: false },
    { requestKey: 'demo-redeem-0003', note: '演示误扣后撤销', reversed: true },
  ];
  for (const [index, item] of usageRows.entries()) {
    const usedAt = new Date(purchasedAt.getTime() + (index + 1) * 60000);
    const reversal = item.reversed ? {
      reversedAt: new Date(usedAt.getTime() + 30000), reversedBy: admin.id,
      reversedByName: admin.username, reverseReason: '演示：操作员误扣一次',
    } : { reversedAt: null, reversedBy: null, reversedByName: null, reverseReason: null };
    await prisma.packageUsage.upsert({
      where: { requestKey: item.requestKey },
      update: {
        holdingId: historyHolding.id, usedAt, usedBy: admin.id,
        usedByName: admin.username, note: item.note, ...reversal,
      },
      create: {
        holdingId: historyHolding.id, requestKey: item.requestKey, usedAt,
        usedBy: admin.id, usedByName: admin.username, note: item.note, ...reversal,
      },
    });
  }

  process.stdout.write('M.77 本地演示数据已准备完成。\n');
}

main()
  .catch(error => { process.stderr.write(`演示数据初始化失败：${error.message}\n`); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
