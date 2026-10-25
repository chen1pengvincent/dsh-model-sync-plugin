# 生态接入与验证证据（Ecosystem evidence）

本文件是 `package.json#dshWorkshop.evidence` 指向的证据说明：记录本插件作为
**Profile Bundle** 插件接入 DSH 时，安装、失败隔离、生命周期与移除四项事实的
验证方式与观察结果。当前事实范围：**DSH kernel `0.2.1-rc.2`（DSH Desktop 2.0.18 与 DSH NEXT 2.0.19-next）**；
`0.2.0-rc.2` 与 `0.1.2-rc.1` 为保留的历史兼容路径。

## 安装（install）

```bash
dsh plugin --profile <name> add github:chen1pengvincent/dsh-model-sync-plugin#<40位commit>
```

- 本包无 `install` / `postinstall` 等安装脚本（`installScriptsMustRemainDisabled: true` 成立）
- 安装后 `dsh.profile.bundles` 需包含 `dsh-model-sync`；重启 DSH 加载宿主与客户端
- DSH 0.2.1+ 在安装与启动时读取 `package.json#engines.dsh`（`>=0.1.2-rc.1 <0.3.0-0`）；
  DSH NEXT 2.0.19-next 使用同一内核与官方插件管理器，安装到默认 `desktop` profile 即可
- 观察：宿主日志出现 `dsh-model-sync: update check complete …`；会话内 `/model-sync status`
  返回结果；设置 → 「模型更新」出现面板

## 能力验证（capability）

- 能力：命令 `/model-sync check`（`kind: command`）
- 调用：在任意会话运行 `/model-sync check`
- 预期观察：返回每个 provider 的新模型数量（`无新增` / `N 个新模型` / `未纳入检查` /
  `检查失败（原因）`），且**不写入** settings
- 对照检查：调用前后 settings 文档不变。DSH 2.0.17+ 的设置已迁入 profile 的
  `cordis.patch.yml`（不再有 `~/.dsh/settings.yaml`），因此比较该文件与 profile
  `package.json` 的哈希即可；`check` 只写自己的 `$DSH_HOME/model-sync/`（状态与 models.dev 缓存），
  不写 settings

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
- 残留物：`$DSH_HOME/model-sync/`（状态、models.dev 缓存、settings 备份；默认 `~/.dsh`）与已添加的模型条目；
  两者都可由用户手动清理，删除后不影响 DSH

## 权限对照（permissions）

| 声明 | 用途 |
|---|---|
| `settings:read` | 读取 `llm-deepseek` / `llm-pi-ai` 配置以计算差异 |
| `settings:write` | 仅在用户于面板勾选并点击「添加所选」后写入；写前自动备份 settings |
| `credentials:read` | 通过 `ctx.credentials.resolve` 在请求时解析 provider API key，通过 `describe` 读取只读元数据；不落盘、不打印 |
| `network:outbound` | 访问 provider `/models` 端点与 models.dev 元数据 |
| `native-code:none` | 无原生代码、无安装脚本、无子进程 |

## 0.2.1 / DSH NEXT 实测（2026-10-21；模型选择器 2026-10-24）

> 本记录不构成对 DSH NEXT 的完整兼容承诺；NEXT GUI 未验证。`v0.9.4` 为当前稳定版，`v0.9.3` 为上一稳定版，`v0.9.2` 为保留的 pre-release。

在隔离的 `DSH_HOME` 中用 DSH Desktop 2.0.18 自带的 kernel `0.2.1-rc.2` 启动自定义 `web` profile：

- `dsh --profile nextweb --dump-config` 组合出 `- id: dsh-model-sync` 行
- 宿主启动后 `GET /model-sync/api/state` 返回 200，`/model-sync` 命令注册成功
- 无头 Chromium 打开 Web UI：设置导航出现「模型更新」，面板默认收起服务商卡片，显示「检查更新 / 添加 N 个模型」；
  console 无 error / exception
- `evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.2')` 返回 `undefined`（满足 `engines.dsh`）
- 负向对照：临时副本把 `engines.dsh` 改为 `>=9.0.0` 后执行 `dsh plugin add`，预检拒绝并输出
  `nothing was installed`，未进入 pnpm 安装
- `0.2.1` 的 credentials 实测语义：`source: 'env'` 且 `writable: true`，不再触发旧版
  「环境遮蔽」告警；只有 `writable: false` 才显示只读提示
- 模型选择器（2026-10-24，合成 settings、无真实 Key）：composer 与 `/model` 都只显示一个
  `OpenCode Go` / `OpenCode` 分组，未出现 `· Responses` 等协议分组；选择分流模型后触发按钮
  正确更新，console 无 error（证明展示合并与真实路由映射同时生效）
- 新模型更新面板（2026-10-25，真实 provider 配置/合成 state）：默认不勾选；provider 卡片两列，
  展开后按厂商分组、支持搜索/全部/未选/已选筛选和厂商组三态勾选；下架/跳过/技术详情只在卡片
  内部「维护与诊断」显示；添加习惯可预选并清除；console 无 error
- 模型选择器回归（2026-10-25）：新面板上线后 composer 与 `/model` 仍按服务商合并，无协议分组

DSH NEXT 2.0.19-next 的 [package.json](https://github.com/anywhere-labs/dsh-desktop/blob/v2.0.19-next/dsh-desktop-next/package.json)
固定依赖 `@deepseek-ai/dsh-app-boot@0.2.1-rc.2`，并复用官方插件管理器；其 GUI 未在本次自动化中单独启动，兼容判定与宿主/客户端行为以同版本内核实测为准。

## 已知环境问题（历史）

DSH Desktop 2.0.6 存在与插件无关的官方路由缺陷（`DeepSeek request extension preparation failed`），
规避方式见 README「已知问题与排查」；该问题已在后续内核修复。
