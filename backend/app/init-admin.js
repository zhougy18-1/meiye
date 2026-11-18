// backend/app/init-admin.js
// 复用 src/db/prisma.js 已配置的客户端（Prisma 7 prisma-client generator + adapter）。
// 用 tsx 运行：容器内 `npx tsx init-admin.js`。
// 和 server.js 一样先加载 .env：db/prisma.js 在模块加载时就读 DATABASE_URL，开发容器不注入环境变量
import 'dotenv/config';
import prisma from './src/db/prisma.js';
import bcrypt from 'bcryptjs';
import { managerUsername } from './src/utils/shopIdentity.js';

// Existing accounts are never overwritten. Only the two configured accounts
// are initialized; legacy staff users stay in the database but cannot log in.
function buildShopAccounts() {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUsername || !adminPassword) {
    process.stderr.write('错误: 必须先设置 ADMIN_USERNAME 和 ADMIN_PASSWORD 环境变量再创建演示账户\n');
    process.exit(1);
  }

  return [
    { role: 'ADMIN', label: '管理员', username: adminUsername, password: adminPassword },
    { role: 'MANAGER', label: '店长', username: managerUsername(), password: process.env.MANAGER_PASSWORD },
  ];
}

async function main() {
  const accounts = buildShopAccounts();
  for (const account of accounts) {
    const existingUser = await prisma.user.findUnique({ where: { username: account.username } });
    if (existingUser) {
      if (existingUser.role !== account.role) throw new Error(`${account.label}账号角色不匹配`);
      process.stdout.write(`${account.label}账号已存在，跳过创建。\n`);
      continue;
    }
    if (!account.password) throw new Error(`创建${account.label}账号前须配置对应密码`);
    const hashedPassword = await bcrypt.hash(account.password, 10);
    await prisma.user.create({
      data: {
        username: account.username,
        password: hashedPassword,
        role: account.role,
      },
    });
    // 仅回显账号名与角色，绝不回显口令或哈希。
    process.stdout.write(`${account.label}账号创建成功：${account.username}\n`);
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
