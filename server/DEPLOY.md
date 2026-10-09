# RemoteType serve 部署手册

GitHub Actions 自动部署（`.github/workflows/deploy.yml`）：runner 上 build 镜像 →
`docker save | gzip` → scp 到服务器 → `docker load` → 重启容器 → `/health` 健康检查。
**不依赖任何 registry**（服务器到 GHCR 慢）。

## 服务器档案

| 项 | 值 |
|---|---|
| 主机 | 1.94.101.189（华为云 `hcss-ecs-b2e2`，Ubuntu 24.04，root@22） |
| 资源 | 2C / 1.7Gi 内存（**长期紧张**）/ 磁盘 71% |
| 端口 | 8790（serve 默认，部署前已确认空闲） |
| 本机 SSH | `ssh root@1.94.101.189`（人肉用 `~/.ssh/id_rsa`） |
| CI 密钥 | `~/.ssh/mn_rt_deploy`（ed25519，公钥已在服务器 authorized_keys） |

## Secrets 配置（一次性）

仓库属主是 **ZHLX2005**，本机 gh 默认认证为 joke-lx（仅 pull）。先切换身份：

```bash
gh auth login -h github.com -w        # 用 ZHLX2005 登录（或 gh auth switch -u ZHLX2005）
```

然后写入 secrets：

```bash
gh secret set HOST -b "1.94.101.189"
gh secret set USERNAME -b "root"
gh secret set PORT -b "22"
gh secret set SSH_KEY < ~/.ssh/mn_rt_deploy     # CI 专用私钥全文，勿用 id_rsa
gh secret set RT_TOKEN -b "<你的门禁token>"      # 可选：注册门禁；不配则服务无门禁
```

> 手机端 / PC 端在服务器设了 `RT_TOKEN` 后也须携带同一 token（PC：`--token`）。

## 触发与回滚

- **自动**：push 到 `main` 且改动 `server/**` 或 workflow 本身
- **手动**：Actions → Deploy → Run workflow（选分支/commit）
- **回滚**：workflow_dispatch 跑旧的 commit（checkout 旧 SHA 重新构建部署）
- 服务器上手动查看：`docker logs -f remotetype_server`、`docker ps`

## 运行时约定

| 项 | 值 |
|---|---|
| 容器 / 镜像 | `remotetype_server` / `remotetype-server:latest` |
| 端口 | 宿主 8790 → 容器 8790 |
| 数据卷 | `mn_rt_data:/app/data`（records.jsonl 持久化）、`mn_rt_logs:/app/logs` |
| 内存上限 | `--memory 256m`（宿主机内存紧张，防灌包拖垮整机） |
| 健康检查 | `GET /health` |

## 已知风险

- **内存**：宿机 available 常年 ~120Mi，大头是 napcat（QQ bot，~620MB）。服务冷启动可用，
  若频繁 OOM 重启优先考虑清理 napcat 或加 swap，而不是调大 `--memory`。
- **磁盘**：每次部署 load 完整镜像（旧 tag 变 dangling），workflow 末尾已 `docker image prune`；
  若磁盘告警先查 `docker images` 和 `mn_rt_logs` 卷。
- **公网裸奔**：8790 对公网开放，WS 无 TLS。正式使用建议前置 nginx + TLS，或至少配置 `RT_TOKEN` 门禁。
