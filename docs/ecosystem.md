# 生态接入与验证证据（Ecosystem evidence）

本文件是 `package.json#dshWorkshop.evidence` 指向的证据说明：记录本插件作为
**Profile Bundle** 插件接入 DSH 时，安装、失败隔离、生命周期与移除四项事实的
验证方式与观察结果。事实范围：**DSH kernel `0.1.2-rc.1`（DSH Desktop 2.0.6）**。

## 安装（install）

```bash
dsh plugin --profile <name> add github:chen1pengvincent/dsh-model-sync-plugin#<40位commit>
```

- 本包无 `install` / `postinstall` 等安装脚本（`installScriptsMustRemainDisabled: true` 成立）
- 安装后 `dsh.profile.bundles` 需包含 `dsh-model-sync`；重启 DSH 加载宿主与客户端
- 观察：宿主日志出现 `dsh-model-sync: update check complete …`；会话内 `/model-sync status`
  返回结果；设置 → 「模型更新」出现面板

## 能力验证（capability）

- 能力：命令 `/model-sync check`（`kind: command`）
- 调用：在任意会话运行 `/model-sync check`
- 预期观察：返回每个 provider 的新模型数量（`无新增` / `N 个新模型` / `未纳入检查` /
  `检查失败（原因）`），且**不写入** settings
- 对照检查：调用前后 `~/.dsh/settings.yaml` 的 mtime 与内容不变

## 失败隔离（failureIsolation）

- 上游不可达 / 返回非 JSON / 空列表：该 provider 标记为「检查失败」，其余 provider 继续；
  settings 不被修改
- 启动检查失败：只写 `warn` 日志，插件继续运行
- 写入失败（DSH schema 或 `assertServiceable` 拒绝）：`ctx.settings.mutate` 抛出，
  该路由记录错误，其余路由不受影响；settings 文档保持最后一次成功状态
- 安装失败：由 DSH/Pnpm 的 Profile Bundle 事务回滚（`generation-rollback`）；
  本插件不在安装期触碰 current generation
- 状态文件损坏：自动备份为 `.corrupt-<ts>` 后重建，不阻塞 DSH 启动

## 生命周期（hotReload / restart）

- 宿主插件代码在 `restart-profile` 时加载（lifecycle 声明）
- 运行期通过 `ctx.settings.mutate` 写入的 provider/模型配置由 DSH 热解析，无需重启
- 客户端面板随 DSH 客户端模块加载；面板内操作即时生效
- `dispose: supported`：定时器、`webServer` 路由、命令注册均在 cordis effect 中注册清理

## 移除（remove）

1. 从 profile 的 `package.json` 移除依赖 `dsh-model-sync`，并从 `dsh.profile.bundles` 移除同名条目
2. 在 profile 目录执行 `pnpm remove dsh-model-sync`（或重新 `pnpm install`）
3. 重启 DSH

- 观察：`/model-sync` 命令消失、「模型更新」面板消失；DSH 其余功能正常
- 残留物：`~/.dsh/model-sync/`（状态、models.dev 缓存、settings 备份）与已添加的模型条目；
  两者都可由用户手动清理，删除后不影响 DSH

## 权限对照（permissions）

| 声明 | 用途 |
|---|---|
| `settings:read` | 读取 `llm-deepseek` / `llm-pi-ai` 配置以计算差异 |
| `settings:write` | 仅在用户于面板勾选并点击「添加所选」后写入；写前自动备份 settings |
| `credentials:read` | 通过 `ctx.credentials.resolve` 在请求时解析 provider API key；不落盘、不打印 |
| `network:outbound` | 访问 provider `/models` 端点与 models.dev 元数据 |
| `native-code:none` | 无原生代码、无安装脚本、无子进程 |

## 已知环境问题

DSH Desktop 2.0.6 存在与插件无关的官方路由缺陷（`DeepSeek request extension preparation failed`），
规避方式见 README「已知问题与排查」。
