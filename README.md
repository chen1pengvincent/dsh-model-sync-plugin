# DSH 模型插件 · dsh-model-sync-plugin

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 监控各服务商**上游 `/models`**，列出新增模型；勾选后一键添加到 DSH。**不自动删除、不自动改写、不覆盖你在原生「模型」模块的编辑。**

## 功能

- **检查更新**：启动后自动检查一次（只读），也可在面板手动触发
- **勾选添加**：按 provider 列出上游新模型（默认全选、可取消），点「添加所选」写入 DSH settings
- **默认收起**：新模型列表默认折叠，只有点击展开后才显示搜索与勾选框，长列表不再干扰界面
- **命令**：会话内运行 `/model-sync check` 只读检查并输出各 provider 新模型数量；`/model-sync status` 查看上次结果
- **搜索/筛选**：支持按模型 id 或名称过滤，`全选 / 清空` 只作用于当前筛选结果
- **纳管开关**：每个 provider 可随时「纳入检查」或关闭
- **多协议自动安置**：混合协议的 provider（如 OpenCode Go、OpenCode Console）会自动拆分为主路由 + 按协议的合成路由（Chat / Anthropic / Responses）
- **Sibling-only 安全写入（OpenCode Console）**：`opencode` 主行是内置目录模型的落点，任何新模型只写入 `opencode-chat` / `opencode-messages` / `opencode-responses` 合成路由，主行的 `models` / `api` / `baseURL` 永不被改写
- **协议分流卡隐藏（v0.6.0+）**：原生「模型」页里 `OpenCode Go · Chat Completions` 等合成路由卡片只在表现层隐藏（不改 settings、可逆），列表保持整洁
- **卡片内托管面板（v0.6.0+）**：`OpenCode Go` / `OpenCode` 主卡内展开「协议分流模型（由插件托管）」，按协议列出该插件写入的合成路由模型，可逐个「删除」——删除即从 DSH 可用模型中移除，且随时可在「模型更新」里重新添加
- **OpenCode 会话头自动附带**：为 OpenCode / OpenCode Go 路由在请求时附带 `x-opencode-session`（按会话，无需改 settings）
- **下架仅提示**：上游不再提供的模型只提示，不删除
- **写前备份**：每次写入前备份 `settings.yaml`（保留最近 20 份）

## 支持的 provider

| provider | 上游端点 | 默认 |
|---|---|---|
| `deepseek-official` | `api.deepseek.com/models` | 纳管、默认全选 |
| `opencode-go` | `opencode.ai/zen/go/v1/models` | 纳管、默认全选 |
| `opencode` | `opencode.ai/zen/v1/models`（回退 `opencode.ai/inference/v1/models`） | 纳管、**默认不勾选**（本机账号可见 37 模型）；新模型只写入合成路由 |
| `kimi-coding` | `api.kimi.com/coding/v1/models` | 纳管、默认全选 |
| `openrouter` | `openrouter.ai/api/v1/models` | 纳管、**默认不勾选**（上游 400+ 模型） |

未配置的 provider 会自动跳过；未知 provider 显示为「未纳管」。

### `opencode`（OpenCode Console / zen）的协议分类

> 端点带凭据时返回「账号可见」列表（本机 37 个；未认证的公开目录为 85 个），插件按带凭据结果检查。

- **models.dev 优先**：`claude-*`（Anthropic）、`gpt-*` / `grok-*` / `muse-*`（Responses）、`deepseek-*` / `glm-*` / `kimi-*` / `minimax-*` / `qwen3.8-max` 等（Chat Completions）
- **静态家族规则**（models.dev 无记录时兜底）：`^claude` → Anthropic Messages（如 `claude-opus-5-5-backup`）；`^mistral` → Chat Completions（models.dev 将其标为 `@ai-sdk/mistral`，实际走 OpenAI 兼容端点）
- **跳过**：`gemini-*`（google-generative-ai，手写路由不支持，但内置目录已可选用）、`jev-*`（TypeSafe System One 结构化 API，非聊天协议）、`test`（内部测试 id）
- `claude-*` 5.x 模型写入 sibling 时会带 `forceAdaptiveThinking: true, supportsTemperature: false`；`deepseek*` 带 `requiresReasoningContentOnAssistantMessages: true`（与官方目录一致）

## 安装

前置：DSH Desktop 或 dsh CLI，且 profile 目录可被 pnpm 管理。

```bash
# 安装到 desktop profile（web profile 同理替换 --profile web）
dsh plugin --profile desktop add github:chen1pengvincent/dsh-model-sync-plugin
```

或使用本地路径：

```bash
dsh plugin --profile desktop add /path/to/dsh-model-sync-plugin
```

安装后**重启 DSH**（插件是启动期加载）。若 `dsh` 提示找不到 pnpm，请先让 pnpm 进入 PATH。

> 安装后请确认 profile 的 `package.json` 里 `dsh.profile.bundles` 已包含 `dsh-model-sync`；若没有，手动加入该条目再重启（bundle 层才会带上插件的客户端面板）。
>
> 注意：这里的 `dsh.profile.bundles` 位于 DSH profile 目录（如 `~/.dsh/profiles/desktop/`）下由 DSH 生成的 `package.json`，由 `dsh plugin add` 管理，**不是**本仓库的 `package.json`。

## 使用

打开 **设置 → 模型更新**：

1. 「检查更新」拉取各 provider 上游 `/models`，只列出新增模型
2. 点击某个 provider 的「选择要添加的模型（N 个，已选 M）」展开列表，按需搜索并勾选（openrouter 默认不勾选；列表超过 200 行时用搜索缩小范围）
3. 点「添加所选」，随后即可在原生「模型」设置和会话模型选择器中使用

多协议模型会自动落到对应路由；若某个新模型无法判定协议，会显示在「跳过」中，不会被错误添加。

日常管理分流模型不必回到本页：**设置 → 模型** 中 `OpenCode Go` / `OpenCode` 主卡内即带「协议分流模型」面板（按协议分组、逐个删除；删除只影响 DSH 侧的可用列表，上游与本插件侧仍会照常列出，可在「模型更新」再次添加）。同页的协议分流卡（`OpenCode Go · Anthropic Messages` 等）会被插件自动隐藏，保持界面整洁；隐藏仅为显示层行为，settings 与卡片功能不受影响。

命令行（只读，不写 settings）：

```text
/model-sync check    # 重新检查并按 provider 输出新增数量
/model-sync status   # 查看上次检查/添加结果
```

## 安全设计

- 检查阶段**只读**：不写 settings、不碰凭证
- 添加必须**显式点击**；启动时不会自动添加任何模型
- 所有写入经 `ctx.settings.mutate`，由 DSH 自身 schema 与 `assertServiceable` 校验，非法配置会被拒绝、不落盘
- 同一 provider 的合成路由若与已有同名 provider 冲突，会跳过以免误覆盖
- **删除仅限插件托管的合成路由**：托管面板的「删除」会校验目标必须是本插件分流的 sibling（`opencode-chat` / `-messages` / `-responses` 等），主行与用户自建 provider 永远不可经由该接口改动；删除前照样备份 settings，删除后可随时重新添加
- **兄弟卡隐藏是纯表现层行为**：只在浏览器 DOM 里隐藏对应卡片，不改 settings、可随窗口刷新复原，也不影响这些路由的实际可用性
- 凭证不落盘、不打印

## OpenCode Go 的 `x-opencode-session`

自 2026-09-05 起，OpenCode / OpenCode Go 要求每个推理请求携带一个**按会话稳定**的
`x-opencode-session`，否则返回 `400 MissingSessionID`。DSH 安装的 pi-ai 适配器
（`@earendil-works/pi-ai@0.85.1`）不会发送这个头，而本插件为未收录模型写入的
`opencode-go` 路由带显式 `api:`，即使将来 pi-ai 内置了包装器也**覆盖不到**这条路径。

本插件在**请求时**补上这个头，不写 settings：

- 在 `llm/stream` 瀑布上取到本次请求的 `provider` 与 `sessionId`（会话循环为每个请求盖上
  的持久会话 id）；
- 仅当 provider 命中 OpenCode 前缀（默认 `opencode-go` / `opencode`，含
  `opencode-go-responses`、`opencode-go-messages` 等合成路由）且主机属于 OpenCode
  （从 settings 路由的 `baseURL` 与内置端点推导）时介入；
- 通过 `AsyncLocalStorage` 包裹下游分片流，并临时给 `globalThis.fetch` 打补丁，因此
  chat-completions / responses / anthropic-messages 三种协议一次覆盖；
- 默认值为**每个 DSH 会话一个随机 UUID**（不把内部会话 id 泄露给第三方），同一会话内稳定，
  切换会话即更换，避免把全部会话压进同一个亲和桶导致命中率下降；若调用方已设置该头，则不覆盖。

### 配置（可选）

在 profile 的 `cordis.patch.yml` 里按 id 覆盖本插件行即可（默认开启，无需配置）：

```yaml
- id: dsh-model-sync
  config:
    sessionHeader:
      mode: uuid          # uuid（默认，不透明）| session-id（发送真实会话 id，仅在需要时开启）
      providers: [opencode-go, opencode]   # 前缀匹配，默认即此
      enabled: true       # 设为 false 可整体关闭
```

`sessionHeader: false` 等价于 `enabled: false`。

> 说明：这与在 settings 的 provider 上写一个固定 `headers.x-opencode-session` 不同——固定值会让
> 上游把**所有**会话路由到同一副本，切换会话时前缀缓存失效、费用与延迟上升（社区已有实测）。本插件
> 的做法是按会话取值，正是网关所要求的语义。

## 数据与状态

| 路径 | 说明 |
|---|---|
| `~/.dsh/model-sync/state.json` | 上次检查/应用、纳管开关、合成路由账本 |
| `~/.dsh/model-sync/models.dev.json` | models.dev 元数据缓存（24h TTL，用于协议分类） |
| `~/.dsh/model-sync/backups/` | settings.yaml 写前备份（最近 20 份） |

## 已知问题与排查

### API Key 在设置页只读、无法更改（凭证被启动环境变量遮蔽）

**现象**：设置 → 模型 中某 provider 的 Key 输入框不可编辑，或保存后实际请求仍用旧 Key。

**原因**：同名环境变量（如 `OPENCODE_GO_API_KEY`）存在于 DSH 进程的启动环境中（典型来源：`launchctl setenv` 写进了 launchd 用户域）。DSH 凭证解析优先级为「进程环境 > 凭证文件 > .env」，且环境来源的凭证被刻意设计为只读——防止「你以为改了、实际被遮蔽」。注意：DSH 的「应用内重启」（Electron relaunch）会继承旧进程环境，只有 ⌘Q 完全退出后从 Dock/访达冷启动才会重新读取 launchd 环境。

**修复**：`launchctl unsetenv <变量名>`（或从 shell 配置文件中移除 export），然后 ⌘Q 完全退出并冷启动 DSH，之后设置页即可编辑。

**本插件的检测（v0.5.0+）**：`check` 对每个纳管路由调用 `credentials.describe`（只读元数据，不读取值），发现凭证被环境遮蔽（`writable: false`）时，在设置面板对应卡片上显示醒目警告，并在 `/model-sync check` / `status` 输出中给出 ⚠️ 行与修复步骤。插件只检测和指引，不替用户修改系统环境。

### DSH Desktop 2.0.6：official 路由报 `DeepSeek request extension preparation failed`

**现象**：使用 `deepseek-official`（例如 V4.1 Flash）时，任何请求（包括自动标题生成）都失败，错误为 `DeepSeek request extension preparation failed`；opencode-go / openrouter 等 pi-ai 路由不受影响。

**原因**：DSH Desktop 2.0.6 将内核移入 `app.asar` 后，默认开启的 `dsh-plugin-package-inventory-deepseek`（向 official 请求附加 `dsh_plugin_packages` 元数据）无法解析桌面端自身的活跃条目 `dsh-plugin-desktop`——它的清单就是 `app.asar` 根部的 `package.json`，不在任何 `node_modules` 搜索路径中，导致请求扩展准备阶段直接抛错。本插件与该问题无关。

**临时规避（可逆）**：在 profile 的用户 patch 层追加一条配置覆盖，然后重启 DSH：

```yaml
# 追加到 ~/.dsh/profiles/desktop/cordis.patch.yml
- id: plugin-package-inventory-deepseek
  config:
    enabled: false
```

这只关闭附带在 official 请求上的 `dsh_plugin_packages` 元数据，不影响模型功能。DSH 上游修复解析后，删除该覆盖即可恢复。

**定位方法（供参考）**：临时挂一个 host 插件包装 `ctx.deepseekLlmApiExtensions.prepare`，捕获失败后逐个调用已注册的 provider 并记录 cause，即可看到真正抛错的 provider 与包名。

### OpenCode 免费模型在 DSH 内调用返回 403（上游策略，非插件问题）

**现象**：通过 `opencode` 路由调用上游任何 `*-free` 模型（如 `deepseek-v4.1-flash-free`、`glm-5.3-flash-free`），返回 403 `FreeTierError`：「OpenCode's free tier can only be used from within OpenCode」。

**原因**：OpenCode 上游对免费模型的服务器端策略——免费额度仅限官方 OpenCode 客户端使用；与凭证类型、DSH 端会话头（插件已按会话为路由附带 `x-opencode-session`）无关。付费/常规模型不受影响。

**处理**：插件仍会正确列出并允许添加免费模型，但调用会被上游拒绝——请以付费模型为准。实测时间 2026-10-19（qwen3.8-max、mistral-large-4、claude-haiku-5-5 均正常 200）。

## 生态收录

- 仓库 topics 含 `dsh-plugin`，会被 dshfind、dsh-market 等社区目录自动索引（收录要求：可用 `dsh plugin add` 安装且声明 `dsh.bundle`）
- 本包声明 `package.json#dshWorkshop`（`omdsh-workshop-package/v1`），面向 OMDSH Hub（hub.omdsh.dev）的入库与验证；验证证据见 [`docs/ecosystem.md`](docs/ecosystem.md)
- 声明的可验证能力：命令 `/model-sync check`（只读，不写 settings）
- 兼容基线：DSH kernel `0.1.2-rc.1`（DSH Desktop 2.0.6）与 `0.2.0-rc.2`（DSH Desktop 2.0.17；该版把 settings.yaml 迁移为条目式 Config，旧的 `settings.get(ns)` 读取形态不存在了，v0.5.1 起两种形态都支持——低于 v0.5.1 的版本在 2.0.17 上会把全部路由误报为「未纳入检查」）

## 开发

```bash
node --test                 # 单元测试（引擎 + 控制器 + 会话头）
node scripts/dry-run.mjs    # 真实上游 dry-run：读本机凭证，只读不写
```

依赖 DSH kernel 的公开 seam：`ctx.settings`、`ctx.credentials`、`ctx.webServer`、`llm/stream` 瀑布、客户端 `slots`。会话头半仅使用 `llm/stream` 与 `globalThis.fetch`，不依赖内核内部符号。当前适配内核 `0.2.0-rc.2`（DSH Desktop 2.0.17），兼容 `0.1.2-rc.1`（DSH Desktop 2.0.6）。

## 卸载

从 profile 的 `package.json` 中移除 `dependencies` 与 `dsh.profile.bundles` 里的 `dsh-model-sync`，删除 `node_modules` 链接后重启 DSH。已写入的模型条目不受影响，可在原生「模型」模块里自行增删。

## License

MIT
