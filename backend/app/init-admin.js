// backend/app/init-admin.js
// 复用 src/db/prisma.js 已配置的客户端（Prisma 7 prisma-client generator + adapter）。
// 用 tsx 运行：容器内 `npx tsx init-admin.js`。
// 和 server.js 一样先加载 .env：db/prisma.js 在模块加载时就读 DATABASE_URL，开发容器不注入环境变量
import 'dotenv/config';
import prisma from './src/db/prisma.js';
import bcrypt from 'bcryptjs';
import { P0_GAP_POLICIES } from './src/config/p0GapPolicies.js';

// 依赖待决 Q-10，当前采用建议默认值，待经营者确认后可调整：
// 本轮补建 MANAGER / STYLIST / ASSISTANT 三个演示账号，便于四级越权回归测试。
// 安全约束（全程遵守）：
//   1) 密码只从环境变量读取，代码 / 文档 / Git / 日志中绝不出现任何密码值；
//   2) 三个新增角色共用 process.env.DEMO_STAFF_PASSWORD；未设置时回退到既有 .env 的
//      ADMIN_PASSWORD，因此默认四个角色使用同一演示密码；
//   3) 账号名固定（可由同名环境变量覆盖，仅用于避免与已有账号冲突），不回显密码；
//   4) 已存在的账号跳过创建（幂等），不覆盖既有 ADMIN 的口令。
function buildDemoAccounts() {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUsername || !adminPassword) {
    process.stderr.write('错误: 必须先设置 ADMIN_USERNAME 和 ADMIN_PASSWORD 环境变量再创建演示账户\n');
    process.exit(1);
  }

  const demoPassword = process.env.DEMO_STAFF_PASSWORD || adminPassword;
  const names = P0_GAP_POLICIES.DEMO_STAFF_USERNAMES;
  const accounts = [
    { role: 'ADMIN', label: '管理员', username: adminUsername, password: adminPassword },
    { role: 'MANAGER', label: '店长', username: process.env.MANAGER_USERNAME || names.MANAGER, password: demoPassword },
    { role: 'STYLIST', label: '美容师', username: process.env.STYLIST_USERNAME || names.STYLIST, password: demoPassword },
    { role: 'ASSISTANT', label: '助理', username: process.env.ASSISTANT_USERNAME || names.ASSISTANT, password: demoPassword },
  ];
  return accounts.filter(account => P0_GAP_POLICIES.DEMO_ROLES.includes(account.role));
}

async function main() {
  const accounts = buildDemoAccounts();
  for (const account of accounts) {
    const existingUser = await prisma.user.findUnique({ where: { username: account.username } });
    if (existingUser) {
      process.stdout.write(`${account.label}演示账户已存在，跳过创建。\n`);
      continue;
    }
    const hashedPassword = await bcrypt.hash(account.password, 10);
    await prisma.user.create({
      data: {
        username: account.username,
        password: hashedPassword,
        role: account.role,
      },
    });
    // 仅回显账号名与角色，绝不回显口令或哈希。
    process.stdout.write(`${account.label}演示账户创建成功：${account.username}\n`);
  }
}

main()
  .catch((e) => {
    process.stderr.write(`创建演示账户失败: ${e.message}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
