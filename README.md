# DSH 模型插件 · dsh-model-sync-plugin

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 监控各服务商**上游 `/models`**，列出当前可用模型；勾选添加、取消勾选移除，保存后一次性生效。

**不自动删除、不自动改写、不覆盖你在原生「模型」模块的编辑。**

本仓库是独立第三方插件，不是 DeepSeek 官方项目。

## 版本与兼容状态

| 版本 | 定位 | 说明 |
|---|---|---|
| `v0.9.6` | **当前稳定版** | DSH Desktop 2.0.18 / kernel `0.2.1-rc.2` 已验证 |
| `v0.9.2` | Next GUI 预发布版（历史） | 保留的 pre-release；不承诺 Nextgen / Next GUI 兼容 |

**已实测**：DSH Desktop 2.0.18，kernel `0.2.1-rc.2`。

**Nextgen / Next GUI 未适配**：相关分支的改动尚未在本插件中完成适配，本版本不承诺兼容 Nextgen 或 Next GUI，也不把它们的界面行为纳入验证范围。请仅在稳定 DSH Desktop 环境中使用；如果使用 Nextgen/Next GUI，请先隔离 profile 并自行承担兼容风险。

`package.json#engines.dsh` 声明 `>=0.1.2-rc.1 <0.3.0-0`；DSH 0.2.1+ 在安装和启动时执行兼容检查。旧版本 tag 已清理，不作为回退安装入口。

## 功能

- **默认不勾选**：每次检查后不自动添加任何模型；用户显式勾选后才生效。
- **全量模型视图**：展开服务商后展示当前上游可用的全部模型，并区分「已添加」「未添加」。
- **双向编辑**：勾选未添加模型、取消勾选已添加模型；点「保存变更」后一次性提交添加和移除。
- **添加/移除反馈**：保存后卡片保持展开；显示聚合 Toast；最新状态在后台同步，不阻塞主操作。
- **服务商一行一张卡片**：按服务商纵向堆叠；卡片默认收起。
- **厂商分组**：模型按厂商分组，使用多列瀑布流填充高度；支持厂商组三态勾选。
- **搜索与筛选**：按模型 id/名称搜索，支持 `全部 / 未添加 / 已添加`。
- **快捷操作**：卡片内提供「全选」和「清空」。全选作用于当前筛选结果中的未添加模型；清空同时清除新增选择和待移除标记。
- **维护与诊断**：最近一次检查发现的下架模型、无法判定协议的模型、检查失败、协议修正、检查范围和上次添加记录，收在每张卡片的折叠区；主列表不主动展示这些信息。
- **命令**：`/model-sync check` 只读检查；`/model-sync status` 查看上次结果。
- **OpenCode 会话头**：为 OpenCode / OpenCode Go 路由按会话附带 `x-opencode-session`。
- **写前备份**：写入 settings 前尝试备份 `settings.yaml`（文件不存在时跳过）。

## 安装

前置：DSH Desktop 或 dsh CLI，且 profile 目录可被 pnpm 管理。

```bash
# 当前稳定版
dsh plugin --profile desktop add github:chen1pengvincent/dsh-model-sync-plugin#v0.9.6
```

> 版本历史仅用于说明，不再提供旧版本回退安装命令。Next GUI 预发布版 `v0.9.2` 仍保留在 Releases，但 Nextgen / Next GUI 未适配，不建议作为稳定环境安装。

或使用本地路径：

```bash
dsh plugin --profile desktop add /path/to/dsh-model-sync-plugin
```

安装后**完全退出 DSH（⌘Q）再冷启动**；仅关闭窗口或刷新页面可能继续加载旧客户端。若 `dsh` 提示找不到 pnpm，请先让 pnpm 进入 PATH。

> 安装后确认 profile 的 `package.json#dsh.profile.bundles` 包含 `dsh-model-sync`。该文件位于 profile 目录（如 `~/.dsh/profiles/desktop/`），不是本仓库的 `package.json`。

## 使用

打开 **设置 → 模型更新**：

1. 点「检查更新」获取各 provider 当前模型。
2. 展开服务商卡片，搜索或按厂商分组浏览。
3. 勾选未添加模型、取消勾选已添加模型；可点卡片内「全选 / 清空」快速操作。
4. 滚到列表底部点「保存全部变更」，卡片保持展开并显示 Toast；列表在后台同步。

### 关于「无法添加」和「已下架」

- **无法添加**：上游模型存在，但当前无法判定 wire protocol，不会进入主列表；详情在卡片「维护与诊断」中。
- **已下架**：上游当前不再提供，但 settings 中仍有记录；只在「维护与诊断」中显示最近一次检查发现的下架模型，历史下架不记录，也不会自动删除。

## 支持的 provider

| provider | 上游端点 |
|---|---|
| `deepseek-official` | `api.deepseek.com/models` |
| `opencode-go` | `opencode.ai/zen/go/v1/models` |
| `opencode` | `opencode.ai/zen/v1/models`（回退 `opencode.ai/inference/v1/models`） |
| `kimi-coding` | `api.kimi.com/coding/v1/models` |
| `openrouter` | `openrouter.ai/api/v1/models` |

未配置的 provider 自动跳过；未知 provider 显示为「未纳管」。

### 多协议与选型分组

OpenCode Go / OpenCode 可能混合 Chat Completions、Anthropic Messages、Responses。插件会在请求层使用主路由 + 按协议的 sibling 路由：

- **模型更新面板**按服务商展示，协议分流不作为独立展示层。
- **composer / `/model`** 也按服务商合并，不出现 `OpenCode Go · Responses` 等分组；选中后透明映射回真实协议路由。

`opencode` 主行属于官方内置目录；新模型只写入 `opencode-chat` / `opencode-messages` / `opencode-responses`，不改写主行的 `models` / `api` / `baseURL`。

## OpenCode Go 的 `x-opencode-session`

OpenCode / OpenCode Go 要求每个推理请求携带按会话稳定的 `x-opencode-session`，否则可能返回 `400 MissingSessionID`。插件在请求时通过 `llm/stream` + `AsyncLocalStorage` + `fetch` 注入；调用方已有该头时不覆盖。默认值是每个 DSH 会话随机生成的 UUID，不泄露内部 session id。

配置覆盖（profile 的 `cordis.patch.yml`）：

```yaml
- id: dsh-model-sync
  config:
    sessionHeader:
      mode: uuid          # uuid（默认）| session-id
      providers: [opencode-go, opencode]
      enabled: true
```

`sessionHeader: false` 等价于 `enabled: false`。

## 数据与状态

路径以进程 `DSH_HOME` 为根（默认 `~/.dsh`）：

| 路径 | 说明 |
|---|---|
| `$DSH_HOME/model-sync/state.json` | 上次检查/应用、纳管开关、sibling 账本、插件添加模型账本、面板打开时间与各服务商最近更新时间 |
| `$DSH_HOME/model-sync/models.dev.json` | models.dev 元数据缓存（24h TTL，用于协议分类与厂商识别） |
| `$DSH_HOME/model-sync/backups/` | settings.yaml 写前备份（最近 20 份；文件不存在时跳过） |

插件不保存凭证。

## 已知问题与排查

### API Key 在设置页只读

- DSH 0.2.1+：桌面端已保存凭据优先，环境变量只是兜底；headless 默认只读环境变量和 `.env`。若输入框仍只读，查看 `credentials.describe` 报告的来源是否本身 `writable: false`。
- DSH ≤0.2.0（历史行为）：同名环境变量会遮蔽凭证文件且只读。移除环境变量后完全退出 DSH 再冷启动。

### 免费模型被上游拒绝

OpenCode 的免费模型可能仅限官方客户端；插件仍会列出，但调用可能被上游拒绝；与插件凭证/会话头无关。

## 版本历史

| 版本 | 日期 | 说明 |
|---|---|---|
| `v0.9.6` | 2026-10-25 | 单列表服务商卡片、更新徽标、列表底部保存、默认不预选 |
| `v0.9.5` | 2026-10-25 | 全量模型视图、双向编辑、移除修复、Nextgen/Next GUI 未适配声明 |
| `v0.9.4` | 2026-10-25 | 渐进式模型更新面板与服务商卡片 |
| `v0.9.3` | 2026-10-24 | composer / `/model` 按服务商合并协议分流 |
| `v0.9.2` | 2026-10-22 | DSH 0.2.1 / NEXT 兼容预发布；Next GUI 预发布版 |
| `v0.9.1` | 2026-10-19 | 修复最后一个协议分流模型删除时的空 models 写入 |
| `v0.9.0` | 2026-10-19 | 托管模型并入官方模型目录、批量移除能力 |
| `v0.8.0` | 2026-10-19 | 官方模型行样式与托管模型目录渲染 |
| `v0.7.0` | 2026-10-19 | 托管模型面板与官方样式复用 |
| `v0.6.0` | 2026-10-19 | 隐藏协议分流卡、主卡托管模型面板 |
| `v0.5.2` | 2026-10-19 | OpenCode Console sibling-only 安全模式 |
| `v0.5.1` | 2026-10-09 | 适配 DSH 2.0.17 条目式 settings |
| `v0.5.0` | 2026-10-09 | 凭证遮蔽检测与未收录模型路由修正 |
| `v0.4.0` | 2026-10-06 | OpenCode 会话头按会话附带 |
| `v0.3.0` | 2026-09-12 | `/model-sync` 只读命令与 dshWorkshop 清单 |

## 开发

```bash
node --test                 # 单元测试
node scripts/dry-run.mjs    # 真实上游 dry-run（读本机凭证，只读）
```

依赖 DSH 公开 seam：`ctx.settings`、`ctx.credentials`、`ctx.webServer`、`llm/stream`、`slots`。会话头半使用 `llm/stream` 与 `globalThis.fetch`，不依赖内核内部符号。

## 卸载

从 profile `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 中移除 `dsh-model-sync`，删除 `node_modules` 链接后重启 DSH。已写入的模型不受影响，可在原生「模型」模块中自行增删。

## 授权

MIT License，Copyright (c) 2026 chen1pengvincent。

本插件按“现状”提供，不附带任何明示或暗示担保；详见仓库根目录 [`LICENSE`](LICENSE)。本插件为非官方第三方项目，不代表 DeepSeek；Nextgen / Next GUI 未适配，使用风险由使用者自行承担。
