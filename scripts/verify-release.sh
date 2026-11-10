#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[1/5] 校验后端 Prisma 数据结构"
(
  cd backend/app
  pnpm build
  pnpm exec prisma validate
)

echo "[2/5] 检查前端代码"
(
  cd frontend/app
  pnpm exec eslint .
)

echo "[3/5] 生成正式前端构建"
(
  cd frontend/app
  VITE_DEMO_MODE=false pnpm build
)

echo "[4/5] 确认正式包不含演示横幅"
if grep -R -q "当前全部为模拟数据" frontend/app/dist; then
  echo "失败：正式构建仍包含演示横幅" >&2
  exit 1
fi

echo "[5/5] 校验部署脚本语法"
bash -n scripts/deploy.sh

echo "正式发布代码检查通过"
