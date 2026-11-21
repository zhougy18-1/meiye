#!/usr/bin/env bash
set -Eeuo pipefail

# M.77 production deployer for the current systemd + nginx layout.
# Run as root on the server:
#   bash scripts/server-deploy-systemd.sh m77-store-v1.0.1

TAG="${1:-}"
APP_ROOT="${APP_ROOT:-/srv/m77}"
BACKUP_ROOT="${BACKUP_ROOT:-/home/ubuntu/qingsi-backups}"
WEB_ROOT="${WEB_ROOT:-/var/www/html}"
SERVICE="${SERVICE:-qingsi-backend.service}"
REPO_ARCHIVE_BASE="${REPO_ARCHIVE_BASE:-https://github.com/zhougy18-1/meiye/archive/refs/tags}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "必须使用 root 运行" >&2
  exit 1
fi
if [[ ! "${TAG}" =~ ^m77-store-v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "用法: $0 m77-store-vX.Y.Z" >&2
  exit 1
fi
if [[ "${APP_ROOT}" != "/srv/m77" || "${WEB_ROOT}" != "/var/www/html" ]]; then
  echo "拒绝在未经校验的目录运行: APP_ROOT=${APP_ROOT}, WEB_ROOT=${WEB_ROOT}" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
VERSION="${TAG#m77-store-v}"
STAGE="$(mktemp -d /tmp/m77-deploy-${STAMP}.XXXXXX)"
BACKUP_DIR="${BACKUP_ROOT}/${TAG}-pre-${STAMP}"
MYSQL_CNF="${STAGE}/mysql.cnf"
DB_NAME_FILE="${STAGE}/db-name"
SERVICE_STOPPED=0
PRODUCTION_MUTATED=0
DEPLOY_FINISHED=0

cleanup() {
  rm -f "${MYSQL_CNF}" "${DB_NAME_FILE}"
  rm -rf "${STAGE}"
}
trap cleanup EXIT

prepare_database_client() {
  node --input-type=module - "${APP_ROOT}/backend/app/.env" "${MYSQL_CNF}" "${DB_NAME_FILE}" <<'NODE'
import fs from 'node:fs';
const [envPath, cnfPath, dbPath] = process.argv.slice(2);
const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find((row) => row.startsWith('DATABASE_URL='));
if (!line) throw new Error('DATABASE_URL 不存在');
let raw = line.slice('DATABASE_URL='.length).trim();
if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
const url = new URL(raw);
const escapeValue = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
const config = `[client]\nuser="${escapeValue(decodeURIComponent(url.username))}"\npassword="${escapeValue(decodeURIComponent(url.password))}"\nhost="${escapeValue(url.hostname)}"\nport=${url.port || '3306'}\nprotocol=tcp\n`;
fs.writeFileSync(cnfPath, config, { mode: 0o600 });
fs.writeFileSync(dbPath, decodeURIComponent(url.pathname.replace(/^\//, '')), { mode: 0o600 });
NODE
}

health_check() {
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restore_after_failure() {
  local exit_code=$?
  if [[ "${DEPLOY_FINISHED}" -eq 1 ]]; then
    return "${exit_code}"
  fi
  set +e
  if [[ "${PRODUCTION_MUTATED}" -eq 1 ]]; then
    echo "部署失败，开始自动恢复 ${BACKUP_DIR}" >&2
    systemctl stop "${SERVICE}"
    rm -rf "${STAGE}/restore"
    mkdir -p "${STAGE}/restore"
    tar -xzf "${BACKUP_DIR}/app-code.tar.gz" -C "${STAGE}/restore"
    rsync -a --delete --exclude='backups' --exclude='node_modules' --exclude='src/generated' "${STAGE}/restore/" "${APP_ROOT}/"
    rm -rf "${WEB_ROOT:?}"/*
    tar -xzf "${BACKUP_DIR}/web-root.tar.gz" -C "${WEB_ROOT}"
    prepare_database_client
    DB_NAME="$(cat "${DB_NAME_FILE}")"
    gzip -dc "${BACKUP_DIR}/database.sql.gz" | mysql --defaults-extra-file="${MYSQL_CNF}" "${DB_NAME}"
    (cd "${APP_ROOT}/backend/app" && pnpm install --frozen-lockfile && pnpm prisma generate)
    systemctl start "${SERVICE}"
    nginx -t && systemctl reload nginx
    health_check
    echo "已自动恢复部署前版本" >&2
  elif [[ "${SERVICE_STOPPED}" -eq 1 ]]; then
    echo "数据库备份阶段失败，生产代码未变；正在重新启动服务" >&2
    systemctl start "${SERVICE}"
    health_check
  else
    echo "部署准备阶段失败，生产环境未发生变更" >&2
  fi
  exit "${exit_code}"
}
trap restore_after_failure ERR

echo "[1/8] 下载并校验 ${TAG}"
curl -fsSL "${REPO_ARCHIVE_BASE}/${TAG}.tar.gz" -o "${STAGE}/release.tar.gz"
tar -tzf "${STAGE}/release.tar.gz" >/dev/null
mkdir -p "${STAGE}/source"
tar -xzf "${STAGE}/release.tar.gz" --strip-components=1 -C "${STAGE}/source"
grep -qx "M77_STORE_VERSION=${VERSION}" "${STAGE}/source/VERSION"

echo "[2/8] 在隔离目录安装依赖并构建"
(cd "${STAGE}/source/backend/app" && pnpm install --frozen-lockfile && pnpm prisma generate)
(cd "${STAGE}/source/frontend/app" && pnpm install --frozen-lockfile && pnpm build)
test -s "${STAGE}/source/frontend/app/dist/index.html"

echo "[3/8] 创建代码与网页备份"
mkdir -p "${BACKUP_DIR}"
tar \
  --exclude='./backups' \
  --exclude='node_modules' \
  --exclude='src/generated' \
  --exclude='*.env.bak*' \
  -C "${APP_ROOT}" -czf "${BACKUP_DIR}/app-code.tar.gz" .
tar -C "${WEB_ROOT}" -czf "${BACKUP_DIR}/web-root.tar.gz" .
tar -tzf "${BACKUP_DIR}/app-code.tar.gz" >/dev/null
tar -tzf "${BACKUP_DIR}/web-root.tar.gz" >/dev/null

FROM_VERSION="legacy-unversioned"
if [[ -f "${APP_ROOT}/VERSION" ]]; then
  FROM_VERSION="$(sed -n 's/^M77_STORE_VERSION=//p' "${APP_ROOT}/VERSION" | head -1)"
fi
cat > "${BACKUP_DIR}/metadata.env" <<EOF
FROM_VERSION=${FROM_VERSION}
TARGET_VERSION=${VERSION}
TARGET_TAG=${TAG}
CREATED_AT=$(date -Is)
SERVICE=${SERVICE}
APP_ROOT=${APP_ROOT}
WEB_ROOT=${WEB_ROOT}
EOF

echo "[4/8] 停止写入并备份数据库"
systemctl stop "${SERVICE}"
SERVICE_STOPPED=1
prepare_database_client
DB_NAME="$(cat "${DB_NAME_FILE}")"
mysqldump --defaults-extra-file="${MYSQL_CNF}" --single-transaction --quick --no-tablespaces --routines --triggers --events "${DB_NAME}" | gzip -1 > "${BACKUP_DIR}/database.sql.gz"
gzip -t "${BACKUP_DIR}/database.sql.gz"
PRODUCTION_MUTATED=1

echo "[5/8] 同步版本代码"
rsync -a --delete \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='src/generated' \
  "${STAGE}/source/backend/app/" "${APP_ROOT}/backend/app/"
rsync -a --delete --exclude='node_modules' "${STAGE}/source/frontend/app/" "${APP_ROOT}/frontend/app/"
rsync -a "${STAGE}/source/scripts/" "${APP_ROOT}/scripts/"
install -m 0644 "${STAGE}/source/VERSION" "${APP_ROOT}/VERSION"
install -m 0644 "${STAGE}/source/RELEASES-M77.md" "${APP_ROOT}/RELEASES-M77.md"

echo "[6/8] 安装生产依赖并执行数据库迁移"
(cd "${APP_ROOT}/backend/app" && pnpm install --frozen-lockfile && pnpm prisma generate && pnpm prisma migrate deploy)
rsync -a --delete "${APP_ROOT}/frontend/app/dist/" "${WEB_ROOT}/"

echo "[7/8] 启动服务并检查"
nginx -t
systemctl start "${SERVICE}"
systemctl reload nginx
health_check
curl -fsS -H 'Host: yaoqi.icu' http://127.0.0.1/api/health >/dev/null

echo "[8/8] 安装回滚命令并记录发布"
install -m 0750 "${APP_ROOT}/scripts/server-rollback-systemd.sh" /usr/local/sbin/m77-rollback
mkdir -p "${APP_ROOT}/backups"
printf '%s\n' "${BACKUP_DIR}" > "${APP_ROOT}/backups/latest-predeploy-backup"
cat > "${APP_ROOT}/backups/current-release.env" <<EOF
VERSION=${VERSION}
TAG=${TAG}
DEPLOYED_AT=$(date -Is)
PREDEPLOY_BACKUP=${BACKUP_DIR}
EOF

SERVICE_STOPPED=0
DEPLOY_FINISHED=1
trap - ERR
echo "部署成功: ${TAG}"
echo "回滚备份: ${BACKUP_DIR}"
echo "回滚命令: m77-rollback latest"
