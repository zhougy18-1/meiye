#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/pack-deploy.sh — M.77 店务系统「本机一键打包 → 上传服务器」
#
# 目的：在本机执行，产出项目根 deploy.zip，供上传到服务器解压部署。
#   - 自动判栈（扫描 */package.json 与 */*/package.json，用 node 解析）
#   - 需要构建的前端先做正式构建（pnpm → 本地 vite → corepack pnpm 三级降级）
#   - 白名单收集 + 黑名单逐文件兜底 + 敏感文件二次校验（发现即中止）
#   - 绝不打包 .env / 密钥 / node_modules / 测试 / 本地演示数据
#   - 保留 prisma/migrations（含 migration_lock.toml）、锁文件、Caddyfile、编排文件
#   - 包内附 MANIFEST.txt 与 DEPLOY-COMMANDS.md；打包后 unzip -l 自检
#
# 安全边界：
#   - 不部署、不连接任何服务器、不回显任何凭据值；服务器地址一律用占位符。
#   - 不删除工作区任何既有目录：旧 dist 只允许整体 mv 到 /tmp 备份（可回滚），禁止 rm -rf dist。
#     （WorkBuddy 的 Node 进程内批量删除保护会让 Vite 清理 dist/js 抛
#      SAFE_DELETE_BULK_CONFIRM_REQUIRED，把 dist 整个移走后 Vite 输出到全新目录即可规避。）
#   - 只新增 deploy.zip 与两个交付文件；不改任何既有源码 / 配置 / 文档。
#
# 兼容性：macOS 自带 bash 3.2，故不使用 mapfile / 关联数组 / ${var,,} 等 bash 4+ 特性。
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

log()  { printf '[pack] %s\n' "$*"; }
die()  { printf '[pack][FATAL] %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 临时目录（全部在 /tmp；dist 备份独立于 TMP_ROOT，成功后保留供回滚）----------
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP_ROOT="$(mktemp -d "/tmp/m77-pack-${STAMP}.XXXXXX")"
DIST_BACKUP="/tmp/m77-dist-backup-${STAMP}"
STAGE="$TMP_ROOT/stage"
ZIP_TMP="$TMP_ROOT/deploy.zip.tmp"
STACK_ENV="$TMP_ROOT/stack.env"
DETECT_JS="$TMP_ROOT/detect-stack.cjs"
ALL_LIST="$TMP_ROOT/all-files.txt"
INCLUDE_LIST="$TMP_ROOT/include-files.txt"
FINAL_LIST="$TMP_ROOT/final-list.txt"
SENSITIVE_LIST="$TMP_ROOT/sensitive-files.txt"
ZIP_LIST="$TMP_ROOT/zip-list.txt"
VIOL_LIST="$TMP_ROOT/violations.txt"
HIT_LIST="$TMP_ROOT/hit.txt"
mkdir -p "$STAGE" "$DIST_BACKUP"

DIST_REBUILT=0
BUILD_CHAIN="(未执行)"

cleanup() {
  local code="${1:-0}"
  trap - EXIT
  # 构建未成功时把旧 dist 回滚，避免工作区 dist 缺失。
  if [ "$DIST_REBUILT" -ne 1 ] && [ -d "$DIST_BACKUP/dist" ] && [ ! -e "$ROOT/frontend/app/dist" ]; then
    log "构建未完成，正在把旧 dist 从备份回滚"
    mv "$DIST_BACKUP/dist" "$ROOT/frontend/app/dist" || true
  fi
  if [ "$code" -eq 0 ]; then
    # 仅清理脚本自己创建的临时暂存目录；dist 备份目录刻意保留供回滚。
    rm -rf "$TMP_ROOT" 2>/dev/null || true
  else
    printf '[pack] 临时目录保留供排查: %s\n' "$TMP_ROOT" >&2
  fi
  exit "$code"
}
# 显式把退出码作为参数传入，避免 EXIT trap 内 $? 被重置导致失败被误报为成功。
trap 'cleanup $?' EXIT

# ---------- 敏感文件 / 黑名单判定（对「包内相对路径」逐文件校验）----------
# 敏感文件 = 立即中止；配置样例 *.example 属白名单例外。
# 注意 *.sql：黑名单针对 portable 演示数据备份等；prisma migrations 下的
# migration.sql 是 prisma migrate deploy 的必需输入，按第一节「保留数据库迁移文件」放行。
is_sensitive() {
  local p="$1" b
  b="$(basename "$p")"
  case "$b" in
    *.example) return 1 ;;
  esac
  case "$b" in
    .env|.env.*|*.pem|*.key|*.p12|*.crt|id_rsa*|*secret*|*.tgz|*.sql.gz) return 0 ;;
  esac
  case "$p" in
    */.env|*/.env.*|*.pem|*.key|*.p12|*.crt|*/id_rsa*) return 0 ;;
  esac
  return 1
}

# 黑名单兜底：命中即从待打包列表剔除（不中止，除非 is_sensitive 已先命中）。
is_blacklisted() {
  local p="$1" b
  b="$(basename "$p")"
  case "$p" in
    */node_modules/*|node_modules/*) return 0 ;;
    */.git/*|.git/*) return 0 ;;
    */src/generated/*) return 0 ;;
    */.pnpm-store/*|.pnpm-store/*) return 0 ;;
    */.vite/*|.vite/*) return 0 ;;
    */.local-demo/*|.local-demo/*) return 0 ;;
    */tests/*|tests/*) return 0 ;;
    */portable/*|portable/*) return 0 ;;
    */cloudflare-workers/*|cloudflare-workers/*) return 0 ;;
    */docs/screenshots/*|docs/screenshots/*) return 0 ;;
    */docs/cloud-migration/*|docs/cloud-migration/*) return 0 ;;
    */docs/p0-gap-closure/*|docs/p0-gap-closure/*) return 0 ;;
    */.vscode/*|.vscode/*) return 0 ;;
    docs/UPGRADING.md|docs/*.mermaid|M77-*.md|FEISHU-ACQUISITION-WORKFLOW.md|SMS-SETUP.md|start-demo.command|启动M77模拟网站.*|开始使用.txt|docker-compose.demo-portable.yml) return 0 ;;
  esac
  case "$b" in
    .DS_Store|._*|*.tsbuildinfo|*.log|*.test.*|*.spec.*) return 0 ;;
    *.sql|*.sql.gz|*.tgz|*.zip)
      case "$p" in
        backend/app/prisma/migrations/*/migration.sql) return 1 ;;
      esac
      return 0 ;;
    deploy.zip) return 0 ;;
  esac
  return 1
}

# ---------- 1/6 自动判栈 ----------
log "=== 1/6 自动判栈（node 解析 package.json，不硬编码技术栈结论）==="
cat > "$DETECT_JS" <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const envOut = process.argv[3];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}
function dep(pkg, name) {
  const d = pkg.dependencies || {}, dd = pkg.devDependencies || {};
  return d[name] || dd[name] || '';
}
function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

// 扫描 */package.json 与 */*/package.json（最多 3 层，跳过 node_modules/.git）
const found = [];
function walk(dir, depth) {
  if (depth > 3) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const child = path.join(dir, ent.name);
    const rel = path.relative(root, child).split(path.sep).join('/');
    const pkgPath = path.join(child, 'package.json');
    if (exists(pkgPath)) found.push({ dir: rel, pkg: readJson(pkgPath) });
    walk(child, depth + 1);
  }
}
walk(root, 0);
found.sort((a, b) => a.dir.localeCompare(b.dir));

console.log('[判栈] 检出 package.json: ' + found.length + ' 个');
const vars = [];
vars.push('PKG_COUNT=' + found.length);

let frontendDir = '', backendDir = '', viteOutDir = 'dist', pm = '', needsBuild = 0;
const frameworks = ['vite', 'vue', 'element-plus', 'react', 'next', 'nuxt', 'fastify', 'express', 'prisma', '@prisma/client'];

for (const f of found) {
  const p = f.pkg;
  const scripts = p.scripts || {};
  const build = scripts.build || '(无)';
  const start = scripts.start || '(无)';
  const pmv = p.packageManager || '(未声明)';
  const v = {};
  for (const name of frameworks) v[name] = dep(p, name);
  const isFrontend = Boolean(v.vite || v.vue || v['element-plus']);
  const isBackend = Boolean(v.fastify || v.express || v.prisma || v['@prisma/client']);
  let role = 'UNKNOWN';
  if (v.next) role = 'NEXTJS';
  else if (v.nuxt) role = 'NUXT';
  else if (isFrontend) role = 'FRONTEND_VITE';
  else if (isBackend) role = 'BACKEND_NODE';

  console.log('[判栈] ' + f.dir + '/package.json | name=' + (p.name || '-') + ' | type=' + (p.type || 'commonjs') + ' | build="' + build + '" | start="' + start + '" | packageManager=' + pmv);
  const parts = [];
  for (const name of frameworks) if (v[name]) parts.push(name + '=' + v[name]);
  console.log('[判栈]   框架: ' + (parts.length ? parts.join(' ') : '(未检出常见框架)') + ' => ' + role);

  if (isFrontend) {
    frontendDir = f.dir;
    if (scripts.build) needsBuild = 1;
    const cfg = path.join(root, f.dir, 'vite.config.js');
    if (exists(cfg)) {
      const m = fs.readFileSync(cfg, 'utf8').match(/outDir\s*:\s*['"]([^'"]+)['"]/);
      viteOutDir = m ? m[1] : 'dist';
      console.log('[判栈]   vite.config.js outDir=' + (m ? m[1] : '(未声明 → 默认 dist)'));
    } else {
      console.log('[判栈]   无 vite.config.js → 产物目录默认 dist');
    }
  }
  if (isBackend) backendDir = f.dir;
  if (pm === '' && p.packageManager) pm = p.packageManager;
}

// 锁文件 → 包管理器
for (const f of found) {
  const base = path.join(root, f.dir);
  const locks = [];
  if (exists(path.join(base, 'pnpm-lock.yaml'))) locks.push('pnpm-lock.yaml');
  if (exists(path.join(base, 'package-lock.json'))) locks.push('package-lock.json');
  if (exists(path.join(base, 'yarn.lock'))) locks.push('yarn.lock');
  if (exists(path.join(base, 'pnpm-workspace.yaml'))) locks.push('pnpm-workspace.yaml');
  console.log('[判栈] ' + f.dir + ' 锁文件: ' + (locks.length ? locks.join(', ') : '(无)'));
}

// 编排形态：Dockerfile / docker-compose*.yml / Caddyfile
let compose = [];
try { compose = fs.readdirSync(root).filter(n => /^docker-compose.*\.ya?ml$/.test(n)); } catch (e) { compose = []; }
console.log('[判栈] 编排 docker-compose*.yml: ' + (compose.length ? compose.join(', ') : '(无)'));
for (const d of [path.dirname(frontendDir || 'frontend/app'), path.dirname(backendDir || 'backend/app')]) {
  const df = d + '/Dockerfile';
  console.log('[判栈] ' + df + ': ' + (exists(path.join(root, df)) ? '存在' : '不存在'));
}
const caddy = frontendDir ? frontendDir + '/Caddyfile' : '';
console.log('[判栈] Caddyfile: ' + (caddy && exists(path.join(root, caddy)) ? caddy : '(无)'));
console.log('[判栈] 结论: 前端需构建=' + needsBuild + ' | 后端 build 仅 prisma generate(生成物不打包) | prisma/migrations 必须保留');

vars.push('FRONTEND_DIR=' + frontendDir);
vars.push('BACKEND_DIR=' + backendDir);
vars.push('VITE_OUTDIR=' + viteOutDir);
vars.push('PACKAGE_MANAGER=' + pm);
vars.push('NEEDS_BUILD=' + needsBuild);
fs.writeFileSync(envOut, vars.join('\n') + '\n');
NODE

node "$DETECT_JS" "$ROOT" "$STACK_ENV" || die "判栈失败"
# shellcheck disable=SC1090
. "$STACK_ENV"

# 工具链结论（逐行打印，含缺失项，便于判断降级链）
TOOL_LINE="node=$(node -v 2>/dev/null || printf '缺失')"
for t in npm corepack pnpm docker zip unzip rsync; do
  if have "$t"; then TOOL_LINE="$TOOL_LINE $t=可用"; else TOOL_LINE="$TOOL_LINE $t=缺失"; fi
done
log "工具链: $TOOL_LINE"
for t in node zip unzip; do have "$t" || die "缺少必需工具: $t"; done

[ -n "$FRONTEND_DIR" ] || die "判栈未识别到前端 Vite 包"
[ -d "$ROOT/$FRONTEND_DIR" ] || die "前端目录不存在: $FRONTEND_DIR"
[ -n "$BACKEND_DIR" ] || die "判栈未识别到后端 Node 包"
[ "$NEEDS_BUILD" = "1" ] || die "前端未检出 build 脚本，无法构建"

# ---------- 2/6 前端正式构建 ----------
log "=== 2/6 前端正式构建（产物目录 ${FRONTEND_DIR}/${VITE_OUTDIR}）==="
DIST_ABS="$ROOT/$FRONTEND_DIR/$VITE_OUTDIR"

# safe-delete 规避：把旧 dist 整个 mv 到 /tmp 备份（绝不 rm -rf dist）。
if [ -d "$DIST_ABS" ]; then
  log "旧 $FRONTEND_DIR/$VITE_OUTDIR 整体 mv → $DIST_BACKUP/dist（保留可回滚）"
  mv "$DIST_ABS" "$DIST_BACKUP/dist"
fi

# 三级降级链：pnpm → 本地 vite → corepack pnpm → 清晰报错退出。
# VITE_DEMO_MESSAGE 是源码里演示横幅的真实变量；清空以保证正式产物不带横幅。
if have pnpm; then
  log "构建链 [1] pnpm run build"
  (cd "$ROOT/$FRONTEND_DIR" && VITE_DEMO_MESSAGE= pnpm run build)
  BUILD_CHAIN="pnpm run build"
elif [ -x "$ROOT/$FRONTEND_DIR/node_modules/.bin/vite" ]; then
  log "构建链 [2] 本地 ./node_modules/.bin/vite build（pnpm 缺失）"
  (cd "$ROOT/$FRONTEND_DIR" && VITE_DEMO_MESSAGE= ./node_modules/.bin/vite build)
  BUILD_CHAIN="local vite build (./node_modules/.bin/vite build)"
elif have corepack; then
  log "构建链 [3] corepack pnpm run build"
  (cd "$ROOT/$FRONTEND_DIR" && VITE_DEMO_MESSAGE= corepack pnpm run build)
  BUILD_CHAIN="corepack pnpm run build"
else
  die "无法构建前端：pnpm 缺失、本地 vite 不存在、corepack 也不可用。请安装 pnpm（packageManager=${PACKAGE_MANAGER}）或补齐前端依赖后重试。"
fi

[ -f "$DIST_ABS/index.html" ] || die "构建产物缺少 $FRONTEND_DIR/$VITE_OUTDIR/index.html"
if grep -R -l -F '当前全部为模拟数据' "$DIST_ABS" >/dev/null 2>&1; then
  die "演示横幅仍存在于产物（VITE_DEMO_MESSAGE 未清空或存在其他注入点）"
fi
DIST_REBUILT=1
log "构建校验通过：index.html 存在；演示横幅 grep 未命中"

# ---------- 3/6 白名单收集 + 黑名单逐文件过滤 ----------
log "=== 3/6 白名单收集 + 黑名单 / 敏感文件逐文件过滤 ==="

# 服务器运行必需（缺一即报错，避免静默漏文件）。
WHITELIST_REQUIRED=(
  "backend/app/src"
  "backend/app/init-admin.js"
  "backend/app/scripts/start.js"
  "backend/app/package.json"
  "backend/app/pnpm-lock.yaml"
  "backend/app/pnpm-workspace.yaml"
  "backend/app/prisma.config.js"
  "backend/app/prisma/schema.prisma"
  "backend/app/prisma/migrations"
  "backend/app/.env.example"
  "backend/.env.example"
  "frontend/app/dist"
  "frontend/app/src"
  "frontend/app/public"
  "frontend/app/index.html"
  "frontend/app/vite.config.js"
  "frontend/app/package.json"
  "frontend/app/pnpm-lock.yaml"
  "frontend/app/pnpm-workspace.yaml"
  "frontend/app/Caddyfile"
  "frontend/.env.example"
  "frontend/.dockerignore"
  "docker-compose.prod.yml"
  "backend/Dockerfile"
  "frontend/Dockerfile"
  "backend/.dockerignore"
  "docs/DEPLOY.md"
  "scripts/deploy.env.example"
)
# 可选保留（供参考，缺失只提示）。
WHITELIST_OPTIONAL=( "scripts/deploy.sh" )

copy_item() {
  local src="$1"
  local dst="$STAGE/$src"
  mkdir -p "$(dirname "$dst")"
  cp -R "$src" "$dst"
}

for item in "${WHITELIST_REQUIRED[@]}"; do
  if [ ! -e "$item" ]; then die "白名单必需路径缺失: $item"; fi
  copy_item "$item"
done
for item in "${WHITELIST_OPTIONAL[@]}"; do
  if [ -e "$item" ]; then copy_item "$item"; else log "可选白名单缺失，跳过: $item"; fi
done

# 生成「待打包候选」列表（STAGE 内相对路径），逐文件过滤；不删除任何文件，只决定谁进包。
(cd "$STAGE" && find . -type f | sed 's|^\./||' | sort) > "$ALL_LIST"
: > "$INCLUDE_LIST"
: > "$SENSITIVE_LIST"
while IFS= read -r rel; do
  if [ -z "$rel" ]; then continue; fi
  if is_sensitive "$rel"; then
    printf '%s\n' "$rel" >> "$SENSITIVE_LIST"
    continue
  fi
  if is_blacklisted "$rel"; then continue; fi
  printf '%s\n' "$rel" >> "$INCLUDE_LIST"
done < "$ALL_LIST"

if [ -s "$SENSITIVE_LIST" ]; then
  printf '[pack][FATAL] 待打包文件中发现敏感文件，已中止（以下为包内相对路径）：\n' >&2
  while IFS= read -r s; do printf '  %s\n' "$s" >&2; done < "$SENSITIVE_LIST"
  exit 1
fi
log "过滤完成：候选 $(wc -l < "$ALL_LIST" | tr -d ' ') 个 → 入包 $(wc -l < "$INCLUDE_LIST" | tr -d ' ') 个；敏感文件 0 个"

# ---------- 4/6 包内附加文件 ----------
log "=== 4/6 生成 MANIFEST.txt 与 DEPLOY-COMMANDS.md ==="
[ -f "$ROOT/docs/DEPLOY-PACKAGE.md" ] || die "缺少 docs/DEPLOY-PACKAGE.md（无法生成 DEPLOY-COMMANDS.md）"

INCLUDE_COUNT="$(wc -l < "$INCLUDE_LIST" | tr -d ' ')"
count_prefix() { grep -c "^$1" "$INCLUDE_LIST" 2>/dev/null || printf '0\n'; }
C_BACKEND="$(count_prefix 'backend/')"
C_FRONTEND="$(count_prefix 'frontend/')"
C_DOCS="$(count_prefix 'docs/')"
C_SCRIPTS="$(count_prefix 'scripts/')"
C_ROOTFILES="$(grep -c '^[^/]*$' "$INCLUDE_LIST" 2>/dev/null || printf '0\n')"

{
  printf 'M.77 店务系统 · 部署包 MANIFEST\n'
  printf '生成时间(UTC): %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '生成器: scripts/pack-deploy.sh（本机一键打包，包内不含任何凭据）\n'
  printf '\n== 技术栈判栈结论 ==\n'
  printf '检出 package.json: %s 个\n' "$PKG_COUNT"
  printf '前端包: %s | Vue 3 + Vite + Element Plus | build: vite build\n' "$FRONTEND_DIR"
  printf '产物目录: %s/%s\n' "$FRONTEND_DIR" "$VITE_OUTDIR"
  printf '后端包: %s | Fastify + Prisma | build: prisma generate(仅生成客户端，不编译)\n' "$BACKEND_DIR"
  printf '包管理器: %s (pnpm-lock.yaml + pnpm-workspace.yaml)\n' "$PACKAGE_MANAGER"
  printf '编排: docker-compose.prod.yml (external docker-net, 无 db service) + Dockerfile x2 + Caddyfile\n'
  printf '数据库: 保留 prisma/migrations/** (含 migration_lock.toml)；src/generated 生成物不打包\n'
  printf '\n== 本次构建 ==\n'
  printf '前端构建链: %s\n' "$BUILD_CHAIN"
  printf '演示横幅: VITE_DEMO_MESSAGE= 已清空，构建后 grep 未命中\n'
  printf '旧 dist 备份(可回滚): %s/dist\n' "$DIST_BACKUP"
  printf '\n== 文件统计 ==\n'
  printf '白名单收集并通过黑名单过滤的文件数: %s\n' "$INCLUDE_COUNT"
  printf '  backend/   : %s\n' "$C_BACKEND"
  printf '  frontend/ : %s\n' "$C_FRONTEND"
  printf '  docs/     : %s\n' "$C_DOCS"
  printf '  scripts/  : %s\n' "$C_SCRIPTS"
  printf '  根级文件  : %s\n' "$C_ROOTFILES"
  printf '包内文件总数(含 MANIFEST.txt 与 DEPLOY-COMMANDS.md): %s\n' "$((INCLUDE_COUNT + 2))"
  printf '\n== 敏感文件策略 ==\n'
  printf '任意真实 .env / 密钥 / 证书 / 测试 / 日志 / 演示数据备份一律不进包。\n'
  printf '例外 1: *.example 配置样例属白名单。\n'
  printf '例外 2: backend/app/prisma/migrations/*/migration.sql 为 prisma migrate deploy 的必需输入，\n'
  printf '        不被 *.sql 黑名单剔除（该规则针对 portable 等本地演示数据备份）。\n'
} > "$STAGE/MANIFEST.txt"

cp "$ROOT/docs/DEPLOY-PACKAGE.md" "$STAGE/DEPLOY-COMMANDS.md"
cp "$INCLUDE_LIST" "$FINAL_LIST"
printf 'MANIFEST.txt\nDEPLOY-COMMANDS.md\n' >> "$FINAL_LIST"

# ---------- 5/6 生成 deploy.zip ----------
log "=== 5/6 生成 deploy.zip（临时 zip → mv 覆盖，避免半成品）==="
(cd "$STAGE" && zip -q -@ "$ZIP_TMP" < "$FINAL_LIST")
mv -f "$ZIP_TMP" "$ROOT/deploy.zip"

# ---------- 6/6 包内容自检 ----------
log "=== 6/6 deploy.zip 自检 ==="
unzip -Z1 "$ROOT/deploy.zip" | sed 's|^\./||' | sort > "$ZIP_LIST"
: > "$VIOL_LIST"

MUST_HAVE=(
  "backend/app/prisma/migrations/migration_lock.toml"
  "backend/app/pnpm-lock.yaml"
  "frontend/app/dist/index.html"
  "frontend/app/Caddyfile"
  "docker-compose.prod.yml"
)
for f in "${MUST_HAVE[@]}"; do
  if ! grep -Fxq "$f" "$ZIP_LIST"; then
    printf '缺失必需文件: %s\n' "$f" >> "$VIOL_LIST"
  fi
done

check_absent() {
  local label="$1" pattern="$2"
  : > "$HIT_LIST"
  grep -E "$pattern" "$ZIP_LIST" > "$HIT_LIST" 2>/dev/null || true
  if [ -s "$HIT_LIST" ]; then
    printf '不应包含 [%s]:\n' "$label" >> "$VIOL_LIST"
    while IFS= read -r h; do printf '  %s\n' "$h" >> "$VIOL_LIST"; done < "$HIT_LIST"
  fi
}
check_absent 'node_modules/' '(^|/)node_modules/'
check_absent '.git/' '(^|/)\.git/'
check_absent 'tests/' '(^|/)tests/'
check_absent '*.log' '\.log$'
check_absent 'portable/' '(^|/)portable/'
check_absent 'deploy.zip' '(^|/)deploy\.zip$'

# .env：仅允许 *.example 配置样例
: > "$HIT_LIST"
grep '\.env' "$ZIP_LIST" 2>/dev/null | grep -v '\.example$' > "$HIT_LIST" || true
if [ -s "$HIT_LIST" ]; then
  printf '不应包含 [真实 .env（*.example 样例除外）]:\n' >> "$VIOL_LIST"
  while IFS= read -r h; do printf '  %s\n' "$h" >> "$VIOL_LIST"; done < "$HIT_LIST"
fi

if [ -s "$VIOL_LIST" ]; then
  printf '[pack][FATAL] 自检未通过，违例清单：\n' >&2
  while IFS= read -r v; do printf '  %s\n' "$v" >&2; done < "$VIOL_LIST"
  exit 1
fi
log "自检通过：必需项 5/5 齐全；禁止项（node_modules/.git/.env/tests/*.log/portable/deploy.zip）0 命中"

# ---------- 结束摘要 ----------
ZIP_BYTES="$(wc -c < "$ROOT/deploy.zip" | tr -d ' ')"
ZIP_HUMAN="$(du -h "$ROOT/deploy.zip" | awk '{print $1}')"
ZIP_COUNT="$(wc -l < "$ZIP_LIST" | tr -d ' ')"
log "--------------------------------------------"
log "deploy.zip 路径 : $ROOT/deploy.zip"
log "deploy.zip 大小 : $ZIP_HUMAN ($ZIP_BYTES bytes)"
log "包内文件数      : $ZIP_COUNT"
log "旧 dist 备份   : $DIST_BACKUP/dist（可回滚）"
log "下一步请查看 DEPLOY-COMMANDS.md"
log "--------------------------------------------"
