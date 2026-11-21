# M.77 生产发布与回滚

当前生产架构：

- 后端：`qingsi-backend.service`
- 后端目录：`/srv/m77/backend/app`
- 前端目录：`/srv/m77/frontend/app`
- Nginx 网页目录：`/var/www/html`
- 备份目录：`/home/ubuntu/qingsi-backups`

## 发布固定版本

只允许部署格式为 `m77-store-vX.Y.Z` 的不可移动 Git 标签：

```bash
curl -fsSL \
  https://raw.githubusercontent.com/zhougy18-1/meiye/m77-store-v1.0.2/scripts/server-deploy-systemd.sh \
  -o /root/m77-deploy.sh
chmod 700 /root/m77-deploy.sh
/root/m77-deploy.sh m77-store-v1.0.2
```

脚本会先在隔离目录下载、安装和构建，确认构建成功后才停止生产服务；随后创建代码、网页和数据库备份，执行数据库迁移并切换到新版本。生产切换后任何步骤失败，脚本会自动恢复部署前状态。

## 查看版本和回滚点

```bash
cat /srv/m77/VERSION
cat /srv/m77/backups/current-release.env
m77-rollback --list
```

每个正式发布备份目录至少包含：

- `app-code.tar.gz`
- `web-root.tar.gz`
- `database.sql.gz`
- `metadata.env`

## 默认回滚（推荐）

```bash
m77-rollback latest
```

默认只恢复后端代码和前端网页，不恢复数据库，因此不会覆盖发布后新增的会员、消费记录等经营数据。适用于数据库迁移保持向后兼容的版本。

## 恢复数据库时点（高风险）

```bash
m77-rollback latest --with-db
```

只有新旧版本数据库结构不兼容、且已确认可以放弃备份时点之后产生的数据时才使用。执行前应停止门店录入并再次导出最新数据。该操作会把数据库内容恢复到发布前备份时点。

## 回滚后的验证

```bash
systemctl is-active qingsi-backend.service
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS -H 'Host: yaoqi.icu' http://127.0.0.1/api/health
nginx -t
```

每次回滚前，脚本还会自动为当前版本创建一个 `pre-rollback-*` 安全快照，便于撤销误回滚。
