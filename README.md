# dsh-model-sync

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 动态发现已配置的模型供应商，检查官方模型目录，并把「要不要添加这个模型」的决定权交还给你。

**查看、启动和检查都不会修改模型配置；只有点击「保存全部变更」才写入。** 不自动删除模型，不自动切换会话模型，不覆盖手工维护的协议、参数和 headers。

> 独立第三方插件，不是 DeepSeek 官方项目。当前版本 **0.11.1**，声明兼容 DSH kernel `>=0.2.2-rc.1 <0.3.0-0`。

## 它解决什么问题

DSH 的模型设置只知道「当前配置里写了什么」，不知道「供应商现在提供了什么」。于是常见三种困境：

- 新加了 OpenAI、Kimi 或智谱的 API，插件列表里却看不到这个供应商；
- 上游更新了模型目录，你不知道多了哪些、少了哪些；
- 想从供应商目录里挑模型，却没有一个地方能看清、勾选并安全保存。

dsh-model-sync 补上这一层：**动态发现 → 拉取官方目录 → 计算未读变化 → 显式勾选 → 校验并保存**。

## 功能一览

| 能力 | 行为 |
|---|---|
| 供应商发现 | 读取 DSH 实际配置的供应商实例，不依赖硬编码名单；同品牌多实例分别记账 |
| 官方目录 | OpenAI、Anthropic、DeepSeek、Kimi、智谱、Gemini、Grok、Meta 八家官方 API |
| 未读变化 | 相对「上次完整查看的目录」计算新增/移除，重复检查不累加，跨刷新与重启保留 |
| 「新增」标记 | 首次展开时标出新增模型，保留到本次收起；已启用的新模型同样会标 |
| 不适用模型过滤 | 非对话端点、重复日期快照、无法判定协议的行不进入主列表，只在诊断中计数 |
| 协议补全 | OpenAI 新模型尚未进入 DSH SDK 目录时仍可选择，保存时显式写入供应商协议并提示 |
| 布局与排序 | 单一厂商官方供应商双列网格；多厂商网关保持分组卡片；全部按显示名自然排序 |
| 安全保存 | 版本 CAS、写前备份、凭据作用域隔离、部分成功精确回执、失败保留旧目录 |
| 受限网络 | 官方目录请求先直连；直连失败或过慢时按环境变量与 macOS 系统代理并行重试，先成功者生效 |

## 网络受限环境（系统代理）

官方目录请求默认直连，只有直连不可用或明显过慢时才启用代理；未配置代理的机器上行为与旧版本完全一致：

1. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（含小写）与 `NO_PROXY` 优先；
2. macOS 上读取系统代理设置（`scutil --proxy`，含例外域名与 IPv4 CIDR 段）；
3. 直连报错时立即改走代理；直连 2.5 秒仍未返回时并行尝试代理，先成功者生效，另一方被取消；
4. 只支持 HTTP 代理（https 经 CONNECT 隧道）；SOCKS 与 PAC 不支持，代理不可用时自动回退直连。

排查时设置 `DSH_MODEL_SYNC_DEBUG_PROXY=1`，插件会把选中的代理与失败原因写到宿主 stderr。

## 安装

要求 DSH kernel `0.2.2-rc.1` 及以上（`<0.3.0-0`）。通过当前 profile 的官方 `plugin_manager` 安装本地仓库目录：

```json
{"action":"install_bundle","target":"/absolute/path/to/dsh-model-sync-plugin"}
```

安装是否热应用，以返回的 `application`、`warnings`、`nextStep` 为准，不要只看“安装成功”。不要手工编辑 profile 清单、依赖或链接。

从旧版本升级时先 `remove_bundle` 再 `install_bundle`。已发布的最新版本是 tag `v0.11.1`（受限网络下的官方目录检查）；可从该 tag 安装，或用 `github:chen1pengvincent/dsh-model-sync-plugin#v0.11.1` 安装。

## 使用

打开 **设置 → 模型更新**。

1. **配置供应商**：在 DSH 原生模型设置里添加供应商和官方 API 凭证。插件按实际端点识别平台，不要求你把供应商命名成某个预设名字。
2. **检查更新**：点击「检查更新」。新增供应商、配置或凭据变化也会触发重新发现；环境变量的外部变化需要重新检查或按 DSH 加载机制重启。
3. **读摘要**：卡片显示类似 **目录 42 个 · 变化 5 项（新增 3 / 移除 2）**；有被过滤的行时追加 **· 已过滤 7**。
4. **展开选择**：展开卡片，搜索、勾选要添加的模型，取消勾选要移除的模型。单一厂商官方供应商为双列网格，多厂商网关按厂商分组。
5. **保存**：在列表底部点击「保存全部变更」。保存后卡片保持展开，并逐项显示成功、失败或后续刷新警告。

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

## 八家官方平台

按**实际端点与产品路径**识别平台，不把所有 OpenAI-compatible 服务都认作 OpenAI。仅接受匹配的 HTTPS 官方端点，不新增中转站或第三方兼容接入。

“支持八家”不意味着八家都提供同一种实时账户 `/models`；智谱使用明确标注的官方公开 schema，不承诺账户权限验证。

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

## 布局与排序

- **双列网格**：单一厂商官方供应商（OpenAI、Anthropic、DeepSeek、Kimi、智谱、Gemini、Grok、Meta），按行排列，充分利用横向空间。
- **分组卡片**：OpenCode、OpenCode Go、OpenRouter 等多厂商网关，维持原来的厂商分组。
- **自然排序**：所有供应商按显示名做数字感知排序（`Model 2` 排在 `Model 10` 前），排序发生在 200 行显示上限之前。

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

## 命令

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

### v0.11.1

- 受限网络下也能建立官方目录：新增 `lib/net-proxy.js`，目录 / legacy `/models` / models.dev 三处请求支持 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`（含小写）与 `NO_PROXY`，没有环境变量时读取 macOS 系统代理（`scutil --proxy`，含例外列表与 IPv4 CIDR）。
- 选路是「直连优先，失败即改代理；直连 2.5 秒未回则并行对冲，先成功者生效」，代理不可用时行为与旧版完全一致；`DSH_MODEL_SYNC_DEBUG_PROXY=1` 可打印选路与失败原因。
- 修复两条边界：对冲之后两侧都失败时必须在毫秒级返回 `REQUEST_FAILED`（此前要等到 20 秒超时）；`redirect: 'error'` 下的 3xx 必须当传输错误，而不是普通 HTTP 状态。
- 凭据只出现在 TLS 密文里：CONNECT 请求头除 `Proxy-Authorization` 外不含任何密钥。
- 验证：`node --test` 337/337（基线 324 + 新增 13 条）；真实 Google 目录经系统代理 `pages=1, models=64`，`gemini-2.5-flash` 可选。未验证：Windows/Linux 系统代理、SOCKS/PAC、需要认证的代理。

### v0.11.0

- 非对话、重复日期快照与协议未知行不进入主列表与未读基线，只在诊断里计数。
- OpenAI SDK 未收录的聊天模型在选择保存时写入供应商级 `api: openai-responses` 并提示协议变更。
- 单厂商官方供应商使用双列网格并按显示名自然排序；多厂商网关保留分组卡片。

## 已知限制

- 目录「变化」只统计模型 ID 的新增与移除；仅名称、上下文窗口等元数据变化不增加未读数。
- 从 0.9.6 迁移的按名称归属，在共享 `DSH_HOME` 下可能把同名路由视为插件拥有；需要严格隔离时使用独立 profile 目录。
- 原生编辑器先保存并增加同 namespace 版本时，随后提交的待移除会被 CAS 安全拒绝。请回到「设置 → 模型更新」重新检查并重新勾选，插件不会自动重基；原生一次保存与后续移除不是同一原子事务。
- 首次为某供应商写入 `api`（OpenAI 协议补全）会改变该供应商的配置作用域，未读基线随之重置一次。
- 视觉验收（图标、展开/折叠、标签渲染）未完成：Client 模块与入口注册已确认，但未取得可认证的界面截图，不能声称已目视通过。

## 开发与验证

```bash
node --test
node --check lib/index.js
node --check lib/client.js
```

使用 Node 内置测试运行器；测试中的供应商 API 为受控响应，不消耗模型额度。当前 **324 项全部通过，0 失败、0 跳过**。覆盖动态供应商发现、八家目录协议、分页与错误保护、目录净差/首次基线/精确版本已读、前端标记生命周期、保存 CAS、手工模型保护、部分成功、跨进程状态并发、不适用模型过滤、重复快照折叠、协议补全与布局排序。

实际 DSH 实机验证与不能证明的事项见[验证记录](docs/ecosystem.md)。**mock 测试通过不等于八家平台的真实账户都已验证**：当前实机只配置并检查了 OpenAI、DeepSeek、Kimi Coding、OpenCode、OpenCode Go、OpenRouter。

## 授权

MIT License，Copyright (c) 2026 chen1pengvincent。详见 [LICENSE](LICENSE)。本插件按“现状”提供，不附带任何明示或暗示担保。
