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

# 注册门禁（可选）
gh secret set RT_TOKEN -b "<你的门禁token>"
```

> 手机端 / PC 端在服务器设了 `RT_TOKEN` 后也须携带同一 token（PC：`--token`）。

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
| 数据卷 | `mn_rt_data:/app/data`（records.jsonl）、`mn_rt_logs:/app/logs` |
| 内存上限 | `--memory 256m`（宿主机紧张，防灌包拖垮整机） |
| 健康检查 | `GET /health` |

## 已知风险

- **内存**：宿机 available 常年 ~120Mi，大头是 napcat（QQ bot，~620MB）。容器冷启动可用，
  若频繁 OOM 重启优先考虑清理 napcat 或加 swap，而不是调大 `--memory`。
- **GHCR pull 慢**：极罕见（多见 GHCR 区域性问题）。workflow 用 `timeout 720` 包裹 pull，
  超时 fall back 到本地缓存——首次 push 后第二次再部署通常就拉到。
- **磁盘**：每次部署 `docker image prune`；若告警先查 `mn_rt_logs` 卷。
- **公网裸奔**：8790 对公网开放，WS 无 TLS。正式使用建议前置 nginx + TLS，或至少配 `RT_TOKEN` 门禁。
