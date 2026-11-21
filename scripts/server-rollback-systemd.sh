#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/srv/m77}"
BACKUP_ROOT="${BACKUP_ROOT:-/home/ubuntu/qingsi-backups}"
WEB_ROOT="${WEB_ROOT:-/var/www/html}"
SERVICE="${SERVICE:-qingsi-backend.service}"

usage() {
  cat <<'EOF'
用法:
  m77-rollback --list
  m77-rollback latest [--with-db]
  m77-rollback /home/ubuntu/qingsi-backups/<备份目录> [--with-db]

默认只恢复代码与网页；只有数据库结构不兼容时才使用 --with-db。
--with-db 会把数据库恢复到该备份时点，之后产生的数据将丢失。
EOF
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "必须使用 root 运行" >&2
  exit 1
fi
if [[ "${APP_ROOT}" != "/srv/m77" || "${WEB_ROOT}" != "/var/www/html" ]]; then
  echo "拒绝在未经校验的目录运行: APP_ROOT=${APP_ROOT}, WEB_ROOT=${WEB_ROOT}" >&2
  exit 1
fi
if [[ "${1:-}" == "--list" ]]; then
  find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r
  exit 0
fi

TARGET="${1:-}"
WITH_DB="${2:-}"
if [[ -z "${TARGET}" ]]; then usage; exit 1; fi
if [[ "${TARGET}" == "latest" ]]; then
  TARGET="$(cat "${APP_ROOT}/backups/latest-predeploy-backup")"
fi
if [[ "${TARGET}" != /* ]]; then TARGET="${BACKUP_ROOT}/${TARGET}"; fi
if [[ "${WITH_DB}" != "" && "${WITH_DB}" != "--with-db" ]]; then usage; exit 1; fi

for required in app-code.tar.gz web-root.tar.gz database.sql.gz metadata.env; do
  test -s "${TARGET}/${required}" || { echo "备份缺少 ${required}: ${TARGET}" >&2; exit 1; }
done
tar -tzf "${TARGET}/app-code.tar.gz" >/dev/null
tar -tzf "${TARGET}/web-root.tar.gz" >/dev/null
gzip -t "${TARGET}/database.sql.gz"

STAMP="$(date +%Y%m%d-%H%M%S)"
SAFETY="${BACKUP_ROOT}/pre-rollback-${STAMP}"
WORK="$(mktemp -d /tmp/m77-rollback-${STAMP}.XXXXXX)"
MYSQL_CNF="${WORK}/mysql.cnf"
DB_NAME_FILE="${WORK}/db-name"
trap 'rm -rf "${WORK}"' EXIT

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
fs.writeFileSync(cnfPath, `[client]\nuser="${escapeValue(decodeURIComponent(url.username))}"\npassword="${escapeValue(decodeURIComponent(url.password))}"\nhost="${escapeValue(url.hostname)}"\nport=${url.port || '3306'}\nprotocol=tcp\n`, { mode: 0o600 });
fs.writeFileSync(dbPath, decodeURIComponent(url.pathname.replace(/^\//, '')), { mode: 0o600 });
NODE
}

health_check() {
  for _ in $(seq 1 30); do
    curl -fsS http://127.0.0.1:3000/api/health >/dev/null && return 0
    sleep 1
  done
  return 1
}

echo "先为当前版本创建安全快照: ${SAFETY}"
mkdir -p "${SAFETY}"
tar --exclude='./backups' --exclude='node_modules' --exclude='src/generated' --exclude='*.env.bak*' -C "${APP_ROOT}" -czf "${SAFETY}/app-code.tar.gz" .
tar -C "${WEB_ROOT}" -czf "${SAFETY}/web-root.tar.gz" .
cp "${TARGET}/metadata.env" "${SAFETY}/rollback-source.env"
cat > "${SAFETY}/metadata.env" <<EOF
FROM_VERSION=$(sed -n 's/^M77_STORE_VERSION=//p' "${APP_ROOT}/VERSION" 2>/dev/null | head -1 || true)
TARGET_VERSION=rollback-safety-snapshot
TARGET_TAG=rollback-safety-snapshot
CREATED_AT=$(date -Is)
SERVICE=${SERVICE}
APP_ROOT=${APP_ROOT}
WEB_ROOT=${WEB_ROOT}
EOF

systemctl stop "${SERVICE}"
prepare_database_client
DB_NAME="$(cat "${DB_NAME_FILE}")"
mysqldump --defaults-extra-file="${MYSQL_CNF}" --single-transaction --quick --no-tablespaces --routines --triggers --events "${DB_NAME}" | gzip -1 > "${SAFETY}/database.sql.gz"
gzip -t "${SAFETY}/database.sql.gz"

mkdir -p "${WORK}/app"
tar -xzf "${TARGET}/app-code.tar.gz" -C "${WORK}/app"
rsync -a --delete --exclude='backups' --exclude='node_modules' --exclude='src/generated' "${WORK}/app/" "${APP_ROOT}/"
rm -rf "${WEB_ROOT:?}"/*
tar -xzf "${TARGET}/web-root.tar.gz" -C "${WEB_ROOT}"

if [[ "${WITH_DB}" == "--with-db" ]]; then
  echo "恢复数据库到备份时点"
  gzip -dc "${TARGET}/database.sql.gz" | mysql --defaults-extra-file="${MYSQL_CNF}" "${DB_NAME}"
fi

(cd "${APP_ROOT}/backend/app" && pnpm install --frozen-lockfile && pnpm prisma generate)
nginx -t
systemctl start "${SERVICE}"
systemctl reload nginx
health_check

printf '%s\n' "${SAFETY}" > "${APP_ROOT}/backups/latest-predeploy-backup"
echo "回滚成功: ${TARGET}"
echo "回滚前安全快照: ${SAFETY}"
