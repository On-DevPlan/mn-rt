# RemoteType serve 部署手册

GitHub Actions 自动部署（`.github/workflows/deploy.yml`）：runner build 镜像 →
推 GHCR → 服务器 `docker pull` → 重启容器 → `/health` 健康检查。
**对比老的 save+scp+load 流程：跨境外网不再传 60MB 镜像，只传 ~250 字节的 docker 配置**。

## 服务器档案

| 项 | 值 |
|---|---|
| 主机 | 1.94.101.189（华为云 `hcss-ecs-b2e2`，Ubuntu 24.04，root@22） |
| 资源 | 2C / 1.7Gi 内存（**长期紧张**）/ 磁盘 71% |
| 端口 | 8790（serve 默认，部署前已确认空闲） |
| 本机 SSH | `ssh root@1.94.101.189`（人肉用 `~/.ssh/id_rsa`） |
| CI 密钥 | `~/.ssh/mn_rt_deploy`（ed25519，公钥已在服务器 authorized_keys） |

## Secrets 配置（一次性）

仓库属主是 **On-DevPlan**，本机 gh 默认认证为 **joke-lx**（ADMIN 权限）。
直接写入即可：

```bash
# SSH 部署凭据
gh secret set HOST -b "1.94.101.189"
gh secret set USERNAME -b "root"
gh secret set PORT -b "22"
gh secret set SSH_KEY < ~/.ssh/mn_rt_deploy

# GHCR pull 鉴权（推荐）—— 公开包匿名 pull 偶尔 401（GHCR 同步怪现象）
# 创建 fine-grained PAT: read:packages 即可；或 classic PAT + read:packages
gh secret set GHCR_TOKEN < ~/ghcr_pat.txt

# 注册门禁（可选，旧路径）
gh secret set RT_TOKEN -b "<你的门禁token>"

# ── 统一登录（推荐：取代 RT_TOKEN 与人工复制配对 key）──
# enabled 认 1/true/yes/on。只配 enabled 不配 secret 会让容器**拒绝启动**——
# 这是故意的：用硬编码默认密钥签的令牌等于任何人都能伪造"某用户的一台电脑"。
gh secret set RT_AUTH_ENABLED -b "1"
gh secret set RT_AUTH_JWT_SECRET -b "$(openssl rand -hex 32)"
# issuer 默认 http://47.110.80.47:8082、client 默认 mn-rt，换环境才需要配
gh secret set RT_AUTH_ISSUER -b "http://47.110.80.47:8082"

# 死设备驱逐：离线超过 N 天的注册记录自动删除（默认 30，0 = 关闭）。
# 在线设备绝不误踢；设备回来重连即自愈（密钥随 register 帧恢复）。
# gh secret set RT_DEVICE_TTL_DAYS -b "30"
```

> 手机端 / PC 端在服务器设了 `RT_TOKEN` 后也须携带同一 token（PC：`--token`）。
> 开启统一登录后 `RT_TOKEN` 就不需要了：身份由认证中心断言，两端不再交换任何秘密。

> **`RT_AUTH_JWT_SECRET` 一旦有 PC 登录过就别随手换**：设备令牌是它签的 HS256，
> 换了等于所有已登记电脑下次 `serve` 直接吃 4401，必须每台重新 `auth login`。
> 轮换可以做，但要按"全体设备重新登录一次"来安排。

> **部署后 CI 自己验一遍**（`Pull image and restart` 步骤末尾）：拉
> `GET /auth/oidc/config`，断言 `enabled` 与本次传入的意图一致、开启时还要
> `idpAvailable=true`。这步不是装饰——`RT_AUTH_ENABLED` 曾经只认字面 `'true'`，
> 写成 `1` 会被判成关闭：服务照常起、`/health` 照样绿，而整套属主隔离**静默不存在**。
> 开关有没有真生效只能问运行中的进程。`idpAvailable` 尤其必须在服务端侧验，
> 浏览器打得开认证中心不代表容器出得去。

## 镜像位置

- Package：`ghcr.io/on-devplan/mn-rt/rt-server`
- Tag：每次 push 同时打 `:latest` 和 `:${{ github.sha }}`（后者用于回滚）

## 触发与回滚

- **自动**：push 到 `main` 且改动 `server/**` 或 workflow 本身
- **手动**：Actions → Deploy → Run workflow（选分支/commit 即可回滚旧 SHA）
- **服务器上手动**：`docker logs -f remotetype_server`、`docker ps`

## 运行时约定

| 项 | 值 |
|---|---|
| 容器 / 镜像 | `remotetype_server` / `ghcr.io/on-devplan/mn-rt/rt-server:latest` |
| 端口 | 宿主 8790 → 容器 8790 |
| 数据卷 | `mn_rt_data:/app/data`（records.jsonl + **devices.json**）、`mn_rt_logs:/app/logs` |
| 内存上限 | `--memory 256m`（宿主机紧张，防灌包拖垮整机） |
| 健康检查 | `GET /health` |
| 统一登录开关 | `GET /auth/oidc/config`（`enabled` / `idpAvailable`，响应永不含 secret） |

> `devices.json` 是"哪台电脑属于谁 + 每台的会话密钥"，落在 `mn_rt_data` 卷里。
> **删这个卷 = 所有设备失去属主绑定与密钥**，手机上已缓存的 sessionKey 全部对不上，
> 表现为"连上但每条信封被静默丢弃"——每台 PC 都要重新 `auth login`。

## 已知风险

- **内存**：宿机 available 常年 ~120Mi，大头是 napcat（QQ bot，~620MB）。容器冷启动可用，
  若频繁 OOM 重启优先考虑清理 napcat 或加 swap，而不是调大 `--memory`。
- **GHCR pull 慢**：极罕见（多见 GHCR 区域性问题）。workflow 用 `timeout 720` 包裹 pull，
  超时 fall back 到本地缓存——首次 push 后第二次再部署通常就拉到。
- **磁盘**：每次部署 `docker image prune`；若告警先查 `mn_rt_logs` 卷。
- **公网裸奔**：8790 对公网开放，WS 无 TLS。正式使用建议前置 nginx + TLS，或至少配 `RT_TOKEN` 门禁。
