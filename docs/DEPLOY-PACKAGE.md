# M.77 店务系统 · 部署包服务器安装 / 配置 / 启动命令

> **文档性质**：随 `deploy.zip` 交付的服务器侧操作说明（打包时以 `DEPLOY-COMMANDS.md` 复制进包根）。
> **生成方式**：由 `scripts/pack-deploy.sh` 打包时复制，请勿手工维护两份内容。
> **凭据声明**：包内**不含任何 `.env`**、不含任何密钥、口令或真实服务器地址；本文所有地址均为占位符，须在服务器上现配。

---

## 0. 包内容与前提

`deploy.zip` 内保留原有相对路径层次，主要包含：

- 后端运行源码 `backend/app/src/**`（**已排除** Prisma 生成物 `src/generated/`）、`init-admin.js`、`scripts/start.js`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`prisma.config.js`、`prisma/schema.prisma`、`prisma/migrations/**`（含 `migration_lock.toml`）；
- 前端构建产物 `frontend/app/dist/**`，以及可在服务器重建前端的 `frontend/app/src/**`、`public/**`、`index.html`、`vite.config.js`、`package.json`、锁文件、`Caddyfile`；
- 编排文件 `docker-compose.prod.yml`、`backend/Dockerfile`、`frontend/Dockerfile`、各 `.dockerignore`、配置样例 `*.example`；
- `docs/DEPLOY.md`（部署参考）、`MANIFEST.txt`、本文（`DEPLOY-COMMANDS.md`）。

**已排除**：`node_modules/`、`.git/`、`**/src/generated/`、任意真实 `.env`、密钥/证书、测试、日志、本地演示数据与过程治理文档。

---

## 1. 解压

```bash
unzip deploy.zip -d /srv/m77
cd /srv/m77
```

---

## 2. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | **22 LTS**（后端 `type: module`，Prisma 7.8.0 客户端由 tsx 加载） |
| pnpm | **12.15.0**（两个 `package.json` 的 `packageManager` 均为 `pnpm@12.15.0`） |
| MySQL | **8**，由服务器单独提供；`docker-compose.prod.yml` **没有 db service**，不会为你创建数据库 |
| Docker（可选） | Docker + Compose（走容器方式时才需要） |
| HTTPS 反代 | 生产必须；后端 `SECURE_COOKIE=true` 依赖它透传 `X-Forwarded-Proto` |

安装 pnpm：

```bash
corepack enable
corepack prepare pnpm@12.15.0 --activate
```

若走容器方式，先建好编排要求的外部网络（MySQL 也需接入该网络才能被后端访问）：

```bash
docker network create docker-net 2>/dev/null || true
```

---

## 3. 配置（**必须在服务器上现配**）

```bash
cp backend/app/.env.example backend/app/.env
```

然后按 `docs/DEPLOY.md` 与 `.env.example` 里的键名填写，至少包含：

| 键 | 值 / 说明 |
|---|---|
| `NODE_ENV` | `production` |
| `SECURE_COOKIE` | `true` |
| `CORS_ORIGIN` | `https://<域名>` |
| `TRUST_PROXY` | `loopback,uniquelocal` |
| `JWT_SECRET` | `openssl rand -hex 64` 生成 |
| `SESSION_SECRET` | `openssl rand -hex 64` 生成，**必须与 `JWT_SECRET` 不同** |
| `DATABASE_URL` | 指向服务器 MySQL 8 实例 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 正式管理员账号与口令 |
| `SMS_ENABLED` | `false`（短信资质未就绪） |
| `SMS_PROVIDER` | `disabled` |

生成两个不同的密钥（只显示命令，不记录任何生成值）：

```bash
openssl rand -hex 64
openssl rand -hex 64
```

> **重要**
> 1. 包里**不含** `.env`，任何情况下都不要从本机上传 `.env`。
> 2. `SECURE_COOKIE=true` 时，验证码 session 与 refresh token 的 Cookie 带 `Secure`，**纯 HTTP 公网直连必然登录失败**。外层 HTTPS 反代必须同时透传 `X-Forwarded-Proto: https` 与 `X-Forwarded-For`；`frontend/app/Caddyfile` 已配置 `trusted_proxies static private_ranges` 以保留这些头。
> 3. 短信资质未就绪时保持 `SMS_ENABLED=false` / `SMS_PROVIDER=disabled`，不影响会员、预约、套餐与收银。
> 4. **正式管理员首次登录后立即修改口令**；演示四级账号不得用于生产。

---

## 4. 方式 A：裸机（Node + pnpm）

### 4.1 后端

```bash
cd backend/app
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm exec prisma migrate deploy
```

启动：

```bash
cd backend/app
NODE_ENV=production NODE_OPTIONS='--import tsx' node scripts/start.js
```

> `scripts/start.js` 是生产入口，会**依次**执行 `prisma migrate deploy` → `init-admin.js` → `import ../src/server.js`；迁移失败则不启动，避免新代码读写老数据结构。因此上面手跑的 `migrate deploy` 与启动时的迁移是幂等的，不会重复建表。
> `init-admin.js` 会创建/跳过 ADMIN、MANAGER、STYLIST、ASSISTANT 四级账号，凭据只从环境变量读取。
> 生产请用进程守护（systemd / supervisor / PM2 等）托管该命令，并配置日志轮转与开机自启。

### 4.2 前端

前端只需把 **构建产物** `frontend/app/dist` 交给 Caddy / Nginx 静态托管，不需要在服务器上跑 Vite：

- 按 `frontend/app/Caddyfile` 配置：
  - `handle /api/*` → `reverse_proxy` 到后端 `3000`（容器内用 `BACKEND_HOST`，裸机改为指向本机后端端口）；
  - `@hashed path /assets/* /js/* /css/* /images/*` → 带 hash 的资源设 `Cache-Control: public, max-age=31536000, immutable`；
  - SPA 回退 `try_files {path} /index.html`。
- 若需在服务器自行重建前端：

```bash
cd frontend/app
pnpm install --frozen-lockfile
VITE_DEMO_MESSAGE= pnpm run build
```

> `VITE_DEMO_MESSAGE` 是演示横幅的真实变量（`src/App.vue`），正式构建必须清空；`frontend/app/dist` 已由打包脚本以清空该变量的正式构建产物交付，正常情况下无需重建。

---

## 5. 方式 B：Docker Compose

```bash
cd /srv/m77
docker network create docker-net 2>/dev/null || true
docker compose -f docker-compose.prod.yml up -d --build
```

要点：

- `docker-compose.prod.yml` 声明 `docker-net` 为 **external: true**，必须预先创建，且 MySQL 需接入同一网络。
- 后端容器通过 `NODE_ENTRY=scripts/start.js` + `NODE_OPTIONS=--import tsx` **自动执行迁移与管理员初始化**，无需手动 `migrate deploy`。
- 前端容器由 Caddy 静态托管 `dist`，`${QINGSI_PORT:-8080}:80` 映射端口，`BACKEND_HOST` 指向后端在网络中的别名。
- 后端 `env_file: ./backend/app/.env` —— 该文件需按第 3 节在服务器上现配，**不在包内**。
- 前端 Caddy 监听 `80`（容器内），生产请在前面再加一层 HTTPS 反代。

---

## 6. 探活与验收

```bash
curl -f https://<域名>/api/health      # 期望返回 {"status":"ok"}
curl -f -o /dev/null -w '%{http_code}\n' https://<域名>/   # 登录页期望 200
```

再按 `docs/DEPLOY.md` 逐项核对：

- 四级账号登录与越权拦截（非授权角色后端 403）；
- 收银、套餐办理/扣次/退款作废、预约容量、统一报表基本链路；
- `docs/DEPLOY.md` 中 `CORS_ORIGIN` / `DATABASE_URL` / `JWT_SECRET` / `NODE_ENV` / `SECURE_COOKIE` / `SESSION_SECRET` / `TRUST_PROXY` 的配置说明。

---

## 7. 收尾安全事项

1. 短信资质未就绪时保持 `SMS_ENABLED=false`；不得用模拟通道冒充真实发送。
2. 正式管理员首次登录后**立即改密**；不要复用演示账号或演示口令。
3. `backend/app/.env` 权限收紧（仅运行用户可读），不要提交进任何仓库、不要打进任何备份包。
4. 定期备份 MySQL；迁移由 `prisma migrate deploy` 管理，不要手工改库表结构。
