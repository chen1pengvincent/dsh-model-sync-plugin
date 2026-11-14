# dsh-model-sync

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 动态发现已配置的模型供应商，检查官方模型目录，并把「要不要添加这个模型」的决定权交还给你。

**查看、启动和检查都不会修改模型配置；只有点击「保存全部变更」才写入。** 不自动删除模型，不自动切换会话模型，不覆盖手工维护的协议、参数和 headers。

> 独立第三方插件，不是 DeepSeek 官方项目。当前版本 **0.12.5**，声明兼容 DSH kernel `>=0.2.2-rc.1 <0.3.0-0`。

## 0.12.5：Kimi K3.1 与「清空」

- **OpenCode Go 的 Kimi K3.1 不再被跳过。** `kimi-k3.1-pro` 在 models.dev 里是 `openai-completions`，但本机 DSH SDK 目录没有它；0.12.4 的保守逻辑会把它留在主供应商 `opencode-go` 并警告跳过。现在改为按上游协议把它落到 `opencode-go-chat` 这个协议子路由，带上显式 `api`/`baseURL`，主供应商继续服务 claude/gemini/qwen 等各自协议不同的已知模型。真实宿主保存后，`opencode-go-chat/kimi-k3.1-pro` 对话返回 `ok`。
- **Kimi Coding 的 K3.1 保持可用。** `k3.1-pro` 仍按单协议路由固定为 `anthropic-messages` + `https://api.kimi.com/coding`；真实宿主保存后 `kimi-coding/k3.1-pro` 对话返回 `ok`。
- **上游能力的常态机制。** 协议分类来自 models.dev 的 npm 元数据（缓存 24 小时刷新，每次检查优先取缓存、过期后拉取）；没有按 `kimi-k3.1-pro` 写死任何模型 ID。多协议路由上，本机 SDK 不认识的模型统一落到对应协议子路由；协议也无法判定的模型才跳过并 warning，绝不写 provider 级 `api` 去覆盖已知模型。新增回归测试用完全虚构的 `brand-new-model` 验证了这条通用路径。
- **「清空」现在会真正生成可保存的移除。** 已配置（`added`）且插件可移除的行会被标成待移除，而不是只清掉未保存的勾选。由于 llm-pi-ai 拒绝“供应商一个模型都不剩”的配置，每个供应商会保留主供应商自有的第一个已添加行（不会拿同卡 sibling 行当幸存者），并弹出「至少保留一个模型」提示；其余行全部取消勾选并可保存。真实组件夹具验证：2 个已添加行点「清空」后 1 个保留、1 个待移除，保存请求 `selections` 为空、`removals` 一项，页脚显示「添加 0 个 · 移除 1 个」。
- 验证：`383 tests / 380 pass / 3 fail`（3 个失败仍是 `tests/state.test.js` 的 Electron helper 基线问题），controller `60/60`；隔离真实宿主一次保存 Kimi Coding `k3.1-pro` 与 OpenCode Go `kimi-k3.1-pro`，`errors: []`，自动创建 `opencode-go-chat`，两条路径分别对话返回 `ok`。

## 0.12.4：修复「保存了好几次都报错」

0.12.3 之前，部分 Kimi Coding 配置会出现一种很隐蔽的保存失败：面板只显示通用文案

```text
操作失败；配置和上次成功目录均已保留，请重试
```

但真实异常是宿主校验器抛出的：

```text
llm-pi-ai: provider "kimi-coding" model "k3.1-pro" sets compat
"forceAdaptiveThinking", but its api is "openai-completions"...
```

原因是 `kimi-coding` 路由声明了 Anthropic 的 `compat`，但本机模型目录把 `k3.1-pro` 归为 `openai-completions`；保存时整个 `llm-pi-ai` 配置段校验失败，插件又把异常折叠成通用文案，于是同一组里的 kimi-coding、openai、opencode 看起来一起失败。

0.12.4 的修复分三层：

1. **单协议路由写清传输。** 当路由只声明一种协议、带有 route-wide `compat`、本次确实改动模型，且供应商没有显式 `api` 时，保存会同时固定该协议和对应 `baseURL`。Kimi Coding 因此写成 `api: anthropic-messages`、`baseURL: https://api.kimi.com/coding`；Anthropic SDK 拼出的真实请求是 `/coding/v1/messages`，而不是会 404 的 `/coding/v1/v1/messages`。
2. **目录发现仍走 `/coding/v1`。** 固定调用端点是 `/coding`，但检查更新时继续请求 `/coding/v1/models`；否则保存成功后下一次检查会错误地请求 `/coding/models` 并退回 models.dev。
3. **多协议网关不再被强行统一。** OpenCode Go 同时包含 Anthropic、Gemini、OpenAI 等不同协议的已知模型，provider 级 `api` 会把它们全部改错。最终行为是：**已知模型正常保存；本机目录查不到的模型跳过，并在保存结果里明确 warning**，不会写入猜测的传输，也不会让一个未知模型拖垮整组。

这是一次**有意的部分保存**：例如默认选中的 20 个 OpenCode Go 新模型里，12 个已知模型会保存，8 个目录外模型会跳过并提示。请阅读 warning；如果要保存被跳过的模型，先在供应商配置中显式设置 `api`/`baseURL`，或取消勾选它们。

## 它解决什么问题

DSH 的模型设置只知道「当前配置里写了什么」，不知道「供应商现在提供了什么」。常见困境：

- 新加了 OpenAI、Kimi 或智谱的 API，插件列表里却看不到这个供应商；
- 上游更新了模型目录，你不知道多了哪些、少了哪些；
- 想从供应商目录里挑模型，却没有一个地方能看清、勾选并安全保存。

dsh-model-sync 补上这一层：**动态发现 → 拉取官方目录 → 计算未读变化 → 显式勾选 → 校验并保存**。

## 功能

| 能力 | 行为 |
|---|---|
| 供应商发现 | 读取 DSH 实际配置的供应商实例，不依赖硬编码名单；同品牌多实例分别记账 |
| 官方目录 | OpenAI、Anthropic、DeepSeek、Kimi、智谱、Gemini、Grok、Meta 八家官方 API |
| 未读变化 | 相对「上次完整查看的目录」计算新增/移除，重复检查不累加，跨刷新与重启保留 |
| 「新增」标记 | 首次展开时标出新增模型，保留到本次收起；已启用的新模型同样会标 |
| 不适用模型过滤 | 非对话端点、重复日期快照、无法判定协议的行不进入主列表，只在诊断中计数 |
| 协议处理 | OpenAI 官方新模型可显式补协议；单协议路由安全固定传输；多协议网关不猜测未知模型的协议 |
| 布局与排序 | 单一厂商官方供应商双列网格；多厂商网关保持分组卡片；全部按显示名自然排序 |
| 安全保存 | 版本 CAS、写前备份、凭据作用域隔离、部分成功精确回执、失败保留旧目录 |
| 系统代理开关 | 面板顶部右侧的滑动开关：开启后宿主进程所有走全局 `fetch` 的请求（目录检查、对话补全、MCP HTTP）都走系统代理，关闭后恢复直连；默认开启 |
| 受限网络 | 官方目录请求另有独立通道：先直连，失败或过慢时按环境变量与 macOS 系统代理并行重试，先成功者生效 |

## 安装

要求 DSH kernel `0.2.2-rc.1` 及以上（`<0.3.0-0`）。

### 从 GitHub 安装（推荐）

打开 **DSH → 设置 → 插件 → 安装**，输入：

```text
github:chen1pengvincent/dsh-model-sync-plugin#v0.12.5
```

也可以让当前 profile 的 `plugin_manager` 安装：

```json
{"action":"install_bundle","target":"github:chen1pengvincent/dsh-model-sync-plugin#v0.12.5"}
```

安装后**完全退出并重新打开 DSH**（Host 模块只在 Harness 重启后重新加载；只刷新页面不够），再硬刷新页面（macOS：`Cmd+Shift+R`）。以返回的 `application`、`warnings`、`nextStep` 为准，不要只看「安装成功」；不要手工编辑 profile 清单、依赖或链接。

### 从源码安装

```bash
git clone https://github.com/chen1pengvincent/dsh-model-sync-plugin.git
```

在插件安装入口使用本地目录（将路径替换为实际 checkout）：

```json
{"action":"install_bundle","target":"/absolute/path/to/dsh-model-sync-plugin"}
```

### 升级

从旧版本升级时先 `remove_bundle` 再 `install_bundle`，或直接在插件管理页安装新版本：

```json
{"action":"remove_bundle","target":"dsh-model-sync"}
{"action":"install_bundle","target":"github:chen1pengvincent/dsh-model-sync-plugin#v0.12.5"}
```

## 使用

打开 **设置 → 模型更新**。

1. **配置供应商**：在 DSH 原生模型设置里添加供应商和官方 API 凭证。插件按实际端点识别平台，不要求你把供应商命名成某个预设名字。
2. **检查更新**：点击「检查更新」。新增供应商、配置或凭据变化也会触发重新发现；环境变量的外部变化需要重新检查或按 DSH 加载机制重启。
3. **读摘要**：卡片显示类似 **目录 42 个 · 变化 5 项（新增 3 / 移除 2）**；有被过滤的行时追加 **· 已过滤 7**。
4. **展开选择**：展开卡片，搜索、勾选要添加的模型，取消勾选要移除的模型。单一厂商官方供应商为双列网格，多厂商网关按厂商分组。
5. **保存**：在列表底部点击「保存全部变更」。保存后卡片保持展开，并逐项显示成功、失败或后续刷新警告。

### 保存行为与 warning

- 每个 settings namespace 原子提交；不同 namespace 可能部分成功，界面按供应商逐项显示。
- 单协议路由的首次模型保存可能同时写入供应商级 `api` 与 `baseURL`；这是为了让声明的 `compat` 与真实传输一致，不是把目录元数据整段抄进配置。
- 多协议路由（如 OpenCode Go）不会写入 provider 级 `api`/`baseURL`。本机模型目录里没有的模型会被跳过，并在 `lastApply.warnings` 与界面 warning 中列出；已知模型照常保存。
- 如果有 warning，请先读清楚再决定是否重试；重复提交不会修复目录外模型，只会产生新的备份。

### 系统代理开关

「模型更新」面板顶部的紧凑卡片是**通过系统代理访问模型服务**开关：

- **布局**：说明文字在左，滑动开关在最右侧并垂直居中；整块固定 66 px 高，开关切换时不会跳高。开关本身表达开/关，不再额外显示「已开启」「已关闭」。
- **开启**：状态行显示绿色「已开启系统代理：目录检查与对话都会走它」。鼠标悬停可看到实际接管的地址和来源（环境变量 / 系统设置）。
- **关闭**：状态行变为「已关闭：目录检查与对话都直连。」；开启时出现的绿字消失，但位置保留，高度不变。
- **开了却没有接管**：开关保持开启，标题旁标「未接管」，状态行用琥珀色说明原因（没有可用代理、代理端口探测失败等）。
- **旧宿主或接口不可用**：标「不可用」，不会假装开关已经生效。
- **失败**：状态行用红色显示请求错误，便于排查。

它解决的是「只开了系统代理、没开 TUN / 虚拟网卡」时，DSH 里目录能拉到、对话却超时的问题。

- **开启时做什么**：把 Harness 自带 `@deepseek-ai/dsh-http-proxy` 的全局 dispatcher 按检测到的代理重新安装一次。Node 的 `fetch` 每个请求都会解析这个 dispatcher，所以同一进程里所有走全局 `fetch` 的请求——目录检查、pi-ai 对话补全、MCP HTTP 传输，以及其他调用 `fetch` 的插件——一起生效，不需要重启、不需要改代码、不需要给每个供应商改 Base URL。DSH 自带的 `web_fetch` 工具直接 `import('undici')`，本来就不走全局 dispatcher，因此不受这个开关影响。
- **关闭时做什么**：安装一个显式的「直连」dispatcher，而不是「回到安装前的样子」——否则启动环境里若本来就有代理变量，用户会关不掉。
- **代理从哪来**：先看 `HTTPS_PROXY` / `https_proxy` / `ALL_PROXY` / `all_proxy` / `HTTP_PROXY` / `http_proxy`，没有就看 macOS 系统代理（`scutil --proxy`）。只支持 HTTP(S) 代理；SOCKS/PAC 会被报告为「未检测到」，此时开关仍可打开，但面板会说明当前仍为直连。
- **先探测再接管**：安装前对代理端口做一次 0.8 秒 TCP 探测。代理没在跑（比如 Clash 没启动）时不接管，保持直连并提示原因——一个配了但死掉的代理不应该让整个进程失去网络。
- **回环永远直连**：`localhost`、`127.0.0.0/8`、`::1` 不会被代理，Web UI 与本机会话不受影响。
- **持久化**：选择写在 `model-sync/state.json` 的 `proxyEnabled`，默认开启；下次启动先安装再检查目录。
- **会重新探测**：每次点「检查更新」（以及面板刷新触发的检查）都会重新读一遍系统代理；代理换了端口或换了软件时会自动切换到新的那个；端点没变就不重装，不会抖掉正在进行的请求（只改 `no_proxy` 例外表的情况仍以「关再开」为准，避免每次检查都重装）。开关只存「开/关」，地址永远现场读，所以不存在写死的 `127.0.0.1:7897`。
- **兼容**：如果当前 Harness 版本没有 `@deepseek-ai/dsh-http-proxy`，开关仍然生效于插件自己的目录检查（`lib/net-proxy.js`），并在面板上说明「仅插件的目录检查走系统代理」——对话层需要更新 Harness。

排查：`DSH_MODEL_SYNC_DEBUG_PROXY=1` 会打印插件的选路结果；宿主 dispatcher 的安装结果直接显示在开关左侧的状态行与悬停提示（已开启 / 未接管 / 不可用）。

### 更新数怎么算

- 比较对象是**最近一次完整成功获取的目录 U** 与**该实例上次完整查看的目录 B**。
- 新增 = `U − B`，移除 = `B − U`，变化数 = 两者之和；不是净增量，也不是重复检查的累加。
- 首次成功发现只建立基线，不会把全部历史模型标成新增。若首次展开前上游又变化，这次变化仍会计数并打标，不会被基线吞掉。
- 首次展开会清除筛选并渲染完整目录；**完整渲染成功后**才把该次实际呈现的版本记为已读。只打开页面、只看过滤结果或旧缓存，不清除未读。
- 「新增」标记在本次展开期间保留；收起后再展开按最新未读状态显示。查看 R 时后台到了 R+1，确认 R 不会顺手清掉 R+1。
- 上游不再列出的模型只计入变化与诊断，**不会自动从 DSH 删除**。

### 不适用模型与诊断

以下行不会出现在主列表，也不参与未读统计：

- **非对话端点**：embedding、audio、图像、realtime、moderation、search 等；
- **重复日期快照**：`gpt-5.4-2026-03-05` 在 `gpt-5.4` 已存在且可选时折叠；支持 `-YYYY-MM-DD`、`-YYYYMMDD`、`-preview-MM-DD` 三种形态，且别名必须在上游存在；
- **无法判定协议**的模型（OpenAI 官方路由除外，见下）。

它们只出现在「维护与诊断 → 已过滤的不适用模型」中，按原因分类计数。**已启用的模型永远不会被隐藏。**

### OpenAI 新模型的协议补全

OpenAI 官方路由上，尚未进入 DSH SDK 静态目录的聊天模型（例如新发布的 `gpt-6.1-terra`）仍可选择：

- 列表里标「需写入协议」；
- 勾选后底部会提示：保存会把该供应商的调用协议写为 `openai-responses`；
- 保存时写入供应商级 `api`，已有模型条目和手工参数保持不变。

这是一次真实的传输协议变更，插件只在你明确勾选并保存时执行。自定义命名的 OpenAI 路由（例如 `openai-work` 指向 `api.openai.com`）会回退到厂商标准 SDK 目录判断模型是否已知，避免误标。

## 支持的平台

按**实际端点与产品路径**识别平台，不把所有 OpenAI-compatible 服务都认作 OpenAI。仅接受匹配的 HTTPS 官方端点，不新增中转站或第三方兼容接入。

「支持八家」不意味着八家都提供同一种实时账户 `/models`；智谱使用明确标注的官方公开 schema，不承诺账户权限验证。

| 平台 / 产品 | 目录来源 | 范围与限制 |
|---|---|---|
| **OpenAI** | `https://api.openai.com/v1/models` | 官方账户目录；聊天、embedding、audio 等可能混列，只对已识别聊天家族开放选择 |
| **Anthropic** | `https://api.anthropic.com/v1/models?limit=1000`，`after_id` 翻页 | 以 `has_more === false` 确认完整；retired 模型不可选 |
| **DeepSeek** | `https://api.deepseek.com/models` | 接受官方根、`/v1`、`/anthropic` 配置；目录请求固定同域 `/models`，保留原调用协议 |
| **Kimi / Moonshot** | Moonshot 中国/国际 `/v1/models`；Kimi Coding 中国/国际 `/coding/v1/models` | 区域与产品分别处理，不混用凭据；Coding 端点不提供列表（404/405/501）时回退 models.dev 公开目录并标注来源，不发送凭据；401/403 不回退 |
| **智谱 / Z.ai** | 中国 `docs.bigmodel.cn` OpenAPI；国际 `docs.z.ai` OpenAPI | 官方公开聊天模型目录，非账户可用性验证；两区独立，仅提取 chat-completions model enum |
| **Google Gemini** | `generativelanguage.googleapis.com/v1beta/models`，`nextPageToken` 翻页 | 接受 `/v1beta/openai` 配置但走同域原生目录；须支持 `generateContent` 且为已识别聊天家族 |
| **xAI / Grok** | `https://api.x.ai/v1/language-models` | 官方语言模型目录，不混入图像/视频生成列表；缺失 context 字段不猜 |
| **Meta** | `https://api.meta.ai/v1/models` | 当前官方 Muse 平台，识别 Wonder / Spark / Ember；历史 `api.llama.com` 仅识别为不支持，不自动迁移 |

目录请求禁止重定向和跨站兜底；全部分页、完整结构和每一行都校验成功才提交快照。超时、鉴权/HTTP 失败、坏行、重复 ID、循环游标、空或不完整目录都保留最后一次有效快照，**绝不解释成批量删除**。

### 历史路由兼容

保留 OpenCode、OpenCode Go、OpenRouter 路由支持，避免破坏既有配置；它们**不属于八家官方适配，也不意味着新增中转站支持**。这些多厂商网关继续使用按厂商分组的卡片布局。

OpenCode 的多协议 sibling 路由合并为同一供应商展示。插件只操作自己明确拥有的路由和模型；原生 `opencode` 主路由保持只读，新模型写入对应协议 sibling，不覆盖主行的 `models`、`api` 或 `baseURL`。

## 安全与数据

状态保存在当前 profile 的 `profileContext.dir/model-sync/`；仅在没有 profile context 时回退 `$DSH_HOME/model-sync/`：

| 文件/目录 | 用途 |
|---|---|
| `state.json` | 目录、已读基线、每实例纳管与选择习惯、插件模型归属账本；不保存 API key |
| `models.dev.json` | 历史路由的元数据缓存（24h TTL），不是八家官方目录的权威来源 |
| `backups/` | DSH 实际配置文档的写前备份；索引保留最近 20 个路径；权限 `0600` |

- 凭据只在 Host 通过 DSH credentials 服务解析；作用域指纹使用本地随机盐 HMAC，不向浏览器传 key，错误对外脱敏。
- 官方文档请求不携带账户凭证；models.dev 回退同样不发送凭证。
- 每次保存携带你看到的配置版本；凭据、配置、纳管状态、目录作用域或版本变化时拒绝旧选择，要求重新检查，不自动重基覆盖。
- 每个 settings namespace 原子提交；跨 namespace 可能部分成功，界面逐项列出，只清除已成功的部分。
- 写入前由 `settings.prepareDocument()` 确认实际配置并备份；找不到文档或备份失败就停止写入。
- 原生路由继承内置目录时，保存会先把当前生效目录落成显式列表再追加所选模型，不会用一条新模型替换整份目录；`modelOverrides` 会迁移到条目并清空（llm-pi-ai 不接受二者并存），字段不丢失。
- DSH 中 `models: []` 可能表示恢复 SDK 默认列表，插件不会通过写空数组造成意外恢复。
- 状态写入使用短时跨进程锁、差量合并与原子替换；同键并发返回冲突，已读版本不回退。锁等待上限 120ms，不自动抢占遗留锁。

## 命令与配置

- `/model-sync check`：只读检查，显示目录规模、未读变化和可添加数量。
- `/model-sync status`：读取最近一次结果。

两个命令都不会隐式添加或删除模型。

OpenCode / OpenCode Go 的 `x-opencode-session` 标头支持保留，按 DSH 会话生成稳定 UUID，已有该标头时不覆盖。通过插件配置管理：

```yaml
sessionHeader:
  enabled: true
  mode: uuid             # uuid（默认）或 session-id
  providers: [opencode-go, opencode]
```

## 更新记录

### v0.12.5

- 多协议路由的未知模型改为按 models.dev 协议落到协议子路由，不再跳过；OpenCode Go 的 `kimi-k3.1-pro` 因此可用。
- 新增上游能力回归测试（虚构模型）与单协议 Kimi K3.1 / 双协议 OpenCode Go K3.1 的真实宿主对话验证。
- 「清空」会把已配置且可移除的模型标为待移除；每个供应商保留第一个模型，避免 llm-pi-ai 的空供应商拒绝。
- 验证：`383 tests / 380 pass / 3 fail`，controller `60/60`。

### v0.12.4

- **修复 Kimi Coding 保存失败。** 单协议且带 route-wide `compat` 的路由，在本次改动模型、供应商未显式设置 `api` 时，保存会同时固定协议与 `baseURL`；Kimi Coding 写入 `api: anthropic-messages`、`baseURL: https://api.kimi.com/coding`，避免目录的 `openai-completions` 与路由 `compat` 冲突，也避免 api-only 方案产生 `/coding/v1/v1/messages` 404。
- **保留目录发现端点。** 固定 wire base 为 `/coding` 后，检查更新仍使用 `/coding/v1/models`，不会退化为 `/coding/models` 404/models.dev 回退。
- **多协议网关安全跳过未知模型。** OpenCode Go 等路由不再写 provider 级 `api`/`baseURL`；已知模型正常保存，本机目录没有的模型跳过并在 warning 中列出，避免覆盖 claude/gemini/qwen 等已知模型各自的协议。
- **覆盖边界。** 自定义 baseURL、显式不兼容 api、仅删除/修复、`compat: null`、尾斜杠归一化都有回归测试和可操作错误。
- 验证：`378 tests / 375 pass / 3 fail`（3 个失败是 `tests/state.test.js` 的 Electron helper 基线问题，干净基线相同）；controller `55/55`。隔离真实宿主用用户原始配置一次保存 kimi 6 + openai 1 + opencode 37 + opencode-go 12，`errors: []`，一条 warning 列出 8 个跳过项；保存后六家 provider 检查全部 `ok`。
- 两份独立对抗式审查对最终 `07da8288…` 均为 PASS。

### v0.12.3

- 系统代理开关改为紧凑滑杆：开关右对齐、垂直居中，整块固定 66 px 高；不再显示「已开启」「已关闭」，只保留异常状态「未接管 / 不可用」。
- 修复代理状态误报：`/proxy` 的接管结果在 `next.proxy.active`，并在请求返回后立即更新本地状态，避免目录检查期间绿字与开关不同步。
- `role="switch"`、`aria-checked`、`aria-describedby`、Tab + Space/Enter 与焦点轮廓保留。

### v0.12.2

- 检查更新时重新探测系统代理：每次检查先 `reconcileProxy()`，代理换端口或换软件时自动切换；端点没变就不重装，不抖掉流式对话。
- 探测读启动时的环境快照，不读自己写回去的变量；瞬时 TCP 失败保留可用 dispatcher，换 dispatcher 不等待旧 `close` 排空。

### v0.12.1

- 评审修正：默认开启不再覆盖宿主既有策略；保留代理凭据、`https://` 与 IPv6 写法；`dispose()` 等待安装并卸载；卸载期间 `POST /proxy` 返回 409；先持久化选择再安装。

### v0.12.0

- 新增「通过系统代理访问模型服务」开关：重新安装 Harness 的全局 undici dispatcher，目录检查与对话一起走系统代理；关闭时安装显式直连策略；默认开启并持久化。

### v0.11.x

- v0.11.0：动态供应商发现、未读目录、不适用模型过滤、OpenAI 协议补全、双列/分组布局。
- v0.11.1：目录请求支持环境变量与 macOS 系统代理，直连失败或过慢时并行重试。

## 已知限制

- **部分保存**：多协议路由上无法判定协议的目录外模型仍会被跳过并 warning；可判定协议的模型会落到协议子路由。主提示可能显示「已保存：添加 0 个模型」，请以 warning 为准。
- **通用错误文案仍在**：本次修复移除了当前触发点，但 `applySelection` 对组内其他未知异常的兜底仍可能显示「操作失败；配置和上次成功目录均已保留」。遇到时请保留 `state.json` 和界面提示。
- **目录读取瞬时失败**：极少数情况下 `listModels` 抛错会使本次新增被保守跳过并标记为未知；重试检查/保存即可，不会写入错误传输。
- **compatByModel-only 路由**：只声明 `compatByModel` 的单协议路由目前不做 provider 级固定，未来若出现未知模型仍可能落入通用错误；当前内置路由没有这种形态。
- 目录「变化」只统计模型 ID 的新增与移除；仅名称、上下文窗口等元数据变化不增加未读数。
- 从 0.9.6 迁移的按名称归属，在共享 `DSH_HOME` 下可能把同名路由视为插件拥有；需要严格隔离时使用独立 profile 目录。
- 原生编辑器先保存并增加同 namespace 版本时，随后提交的待移除会被 CAS 安全拒绝。请回到「设置 → 模型更新」重新检查并重新勾选，插件不会自动重基。
- 首次为某供应商写入 `api` 会改变该供应商的配置作用域，未读基线随之重置一次。
- 系统代理只覆盖 HTTP/HTTPS；SOCKS 与 PAC 由 Harness 的 `@deepseek-ai/dsh-http-proxy` 决定，本插件不做转换。Windows / Linux 只读环境变量，不读系统设置（未验证）。
- Harness 自带的 `web_fetch` 工具直接 `import('undici')`，不经过全局 dispatcher，因此不受这个开关影响。
- 本机无法对运行中的 DSH 窗口做截图验收（当前会话鉴权不可用）。组件级使用真实 `lib/client.js` + React 18 夹具验证了布局与交互，但未替代完整宿主里的目视验收。

## 开发与验证

```bash
node --test
node --check lib/index.js
node --check lib/client.js
```

使用 Node 内置测试运行器；测试中的供应商 API 为受控响应，不消耗模型额度。当前测试套件 **383 项**（`380 pass / 3 fail`），覆盖动态供应商发现、八家目录协议、分页与错误保护、目录净差/首次基线/精确版本已读、前端标记生命周期、保存 CAS、手工模型保护、部分成功、跨进程状态并发、不适用模型过滤、重复快照折叠、协议补全、协议/端点固定、协议子路由与「清空」行为。

本机测试环境以 Electron helper 作为 Node 运行时，`tests/state.test.js` 的 3 个「独立进程」用例会因 `process.execPath` 是 Electron helper（退出码 64）失败；`git archive` 的干净基线表现相同。使用标准 Node.js 24+ 运行即可全部通过。

实际 DSH 实机验证与不能证明的事项见[验证记录](docs/ecosystem.md)。**mock 测试通过不等于八家平台的真实账户都已验证**：当前实机只配置并检查了 OpenAI、DeepSeek、Kimi Coding、OpenCode、OpenCode Go、OpenRouter。

## 授权

MIT License，Copyright (c) 2026 chen1pengvincent。详见 [LICENSE](LICENSE)。本插件按「现状」提供，不附带任何明示或暗示担保。
