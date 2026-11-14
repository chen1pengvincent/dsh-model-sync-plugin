# 接入与验证证据

本文件对应 `package.json#dshWorkshop.evidence`。区分当前版本的自动化证据、当前 DSH 实机观察和历史记录，不把兼容声明、mock 测试或旧版本截图当成新版本实测。

## 当前范围

- 插件工作版本：`0.11.1`；当前宿主 kernel：`0.2.2-rc.1`。
- 声明兼容范围：`>=0.2.2-rc.1 <0.3.0-0`。未承诺旧 kernel 或另一套 Next GUI 的兼容性。
- 供应商从公开 `llm.listConfigurableProviders()` 和各实例精确的 settings namespace/path 发现；调用凭据通过 Host credentials 服务解析。
- 官方目录与 DSH SDK 静态模型表分开。八家具体来源、区域、产品路径和限制见 [README](../README.md#八家官方平台)。智谱公开 schema 不等于账户可用性验证；旧 Llama API 不会被自动迁移。

## 安装与生命周期

使用当前 profile 的官方插件管理入口；本地开发安装示例：

```json
{"action":"install_bundle","target":"/absolute/path/to/dsh-model-sync-plugin"}
```

- 不直接编辑 profile 的清单、依赖或补丁，不在 profile 目录运行包管理器。
- 无 install/postinstall 安装脚本，无新增运行时依赖。
- 以安装返回的 `application`、`warnings`、`nextStep` 判断是否热应用，不能仅凭安装成功或 manifest 声明声称界面已更新。
- Host 定时器、事件监听、命令和 HTTP 路由注册均有生命周期清理。停止后的在途检查不能提交目录快照或配置。
- 配置、模型目录和凭据事件触发重新发现；启动检查只读取供应商目录并写插件自身状态，不写模型设置。
- 卸载通过官方插件管理执行；不自动删除已保存的模型或插件状态，以免破坏用户配置。

## 自动化验证

执行：

```bash
node --test
node --check lib/index.js
node --check lib/client.js
```

### 已纳入的回归边界

1. **发现**：动态供应商、同品牌多个实例、精确 namespace/path、端点而非名称识别、配置与凭据作用域隔离。
2. **官方目录**：八家适配、区域和产品区分、分页完整性、禁止重定向、坏行/重复/空目录/超时/HTTP 失败保留最后有效快照、schema 与账户列表区分。
3. **变化与已读**：首次发现建立基线；相对上次查看的净新增/移除；重复检查不累计；R 的确认不清除 R+1；过期历史版本不误确认；已启用新模型仍可标新。
4. **前端**：首次完整展开确认精确版本；当前展开期间新增标签稳定；已读确认失败保留标签并重试；部分保存和网络异常保留未成功草稿；不把配置写入成功后的刷新警告报成保存失败。
5. **保存**：原配置版本 CAS；备份后的凭据/配置/目录/纳管状态再验证；保留手工元数据和协议；只移除明确归属的模型；不通过空模型数组意外恢复 SDK 默认值；不同 namespace 部分成功准确回执。
6. **状态并发**：稳定 HMAC 盐、短时跨进程锁、三方差量合并、同键冲突、已读版本不回退；含两个独立 OS 进程的状态写入回归。
7. **输入与信息安全**：JSON 对象与 64 KiB 上限、严格布尔值、显式 expectedRevisions、精确 owner、安全错误输出、凭据不返回 Client。
8. **历史能力**：OpenCode sibling 分组、会话标头、旧路由显式管理、只读命令。

最终全量 `node --test`：**324 项全部通过，0 失败、0 跳过**（2026-11-12，3396.57 ms）。`git diff --check`、核心模块语法检查与 `npm pack --dry-run --json` 通过；分发包 20 个文件（85149 字节打包 / 288880 字节解包），包含图标和中英文 locale，不包含测试和凭据。覆盖隐式原生协议保留、显式连接配置保留、模型保存后未读基线不重置，以及不适用模型过滤、重复日期快照折叠、OpenAI 显式协议写入、DeepSeek Account 排除、单厂商双列网格与自然排序。受控响应不能证明八家真实账户都已经通过鉴权和模型调用。

对抗审查后补充的回归覆盖：原生目录路由只继承目录时，新增模型会先物化当前生效目录再追加，不会用一条新模型替换整份目录；仅写入 sibling 的保存不会把主路由的继承目录钉死；`modelOverrides` 在保存时迁移到条目并清空块，且只有主路由 models 真正被重写时才清空，避免无写入时丢手工字段；官方公开 schema（智谱）的目录基线不绑定凭据，轮换 key 不会重放全部新增；sibling 归属还要求凭据绑定一致，同传输但自有 key 的用户路由不被隐藏；首次展开前发生的目录变化仍计数并打标；仅同名但端点不同的用户路由不再被当成插件自建 sibling 隐藏；内置路由未声明 defaultBaseURL 时按官方路由表回退（DeepSeek 原生、OpenCode 等），用户自定义 baseURL 不被替换。协议修正建议仍只展示、不自动应用（结构性移动需要用户另行确认）。0.11.0 新增：非对话/重复日期快照/协议未知行不进入主列表与未读基线，只在诊断里计数；OpenAI SDK 未收录的聊天模型在选择保存时写入供应商级 `api: openai-responses` 并提示协议变更；DeepSeek Account 不再发现或展示；单厂商官方供应商使用双列网格并按显示名自然排序，多厂商网关保留分组卡片。日期快照折叠同时覆盖 `-YYYY-MM-DD`、`-YYYYMMDD` 与 `-preview-MM-DD` 三种形态，且别名必须在上游存在且可选；自定义命名的 OpenAI 路由（如 `openai-work` 指向 api.openai.com）会回退到厂商标准 SDK 目录判断模型是否已知，避免把已知模型误标为需写协议；单厂商网格固定两列，自然排序在 200 行显示上限之前执行。

## 实机验证与限制

当前 DSH Desktop 可通过辅助功能读取真实已认证界面。直接打开当前 Web URL 的新浏览器标签返回认证要求；未搜索或绕过认证令牌，也未建立替代服务器或 mock 预览来冒充当前页面。

安装记录：profile 中原 GitHub 0.9.6 已先移除，再以工作区 link 安装 **0.11.0**（`application: applied`，warnings 为空）；Host 与 Client 均加载（`settings.section` 的 `model-sync`、`settings.models.provider-card` 的 `llm-pi-ai` occupant 可见）。实机 `POST /model-sync/api/check` 只验证了当前 profile 实际配置的供应商：OpenAI 官方目录 96、DeepSeek 官方目录 2、Kimi Coding 回退 models.dev 6、OpenCode 40、OpenCode Go 20、OpenRouter 432；未配置 Anthropic、Gemini、Grok、智谱、Meta 账户，因此这些品牌的真实鉴权与调用仍属未验证限制。界面视觉验收（图标、展开/折叠、标签渲染）未完成：Client 模块与入口注册已确认，但未取得可认证的界面截图，不能声称已目视通过。

**原生编辑器旧删除入口的限制**：该入口保留用户勾选时的配置版本。如果原生编辑器先保存并增加同 namespace 版本，后续删除会安全地被 CAS 拒绝；不能自动刷新版本后重放删除。界面引导到「设置 → 模型更新」重新检查、重新勾选，由该面板统一保存。模拟 portal/MutationObserver/save-close 测试不证明原生编辑器实际版本行为，不能声称此限制已消除。

## 对抗式验证说明

使用独立测试生成与故障/并发注入覆盖反例，不只验证正常路径。仓库没有 `.smartcr` 规则库，且用户未选择正式 SmartCR 的无规则降级方式，因此**没有运行或宣称完成正式 SmartCR 流程**；独立对抗测试与正式流程明确分开。

## 权限与数据

| 权限/数据 | 实际用途和边界 |
|---|---|
| settings 读取 | 读取精确实例配置与版本；静态 SDK 模型仅作为本地现状。 |
| settings 写入 | 仅明确保存；先取得实际配置文档并备份，再做版本及作用域验证、CAS 写入。 |
| credentials 读取 | Host 请求时解析；不打印、不保存 key、不向 Client 暴露；官方文档请求不带账户鉴权。 |
| network outbound | 匹配的官方目录及智谱官方公开 schema；历史路由及 models.dev 元数据兼容。 |
| 本地状态 | 当前 profile 的 `profileContext.dir/model-sync`；无 profile context 才使用 `$DSH_HOME/model-sync`。 |
| 备份 | 实际配置文档可能含敏感信息，备份文件权限为 `0600`；索引仅记录最近 20 个路径，不代表自动删除旧备份。 |
| 运行机制 | 无原生代码、无安装脚本；测试可启动受控 Node 子进程，生产插件不启动子进程。 |

状态锁超过 120ms 返回忙；不会自动抢占遗留锁。设置服务的 CAS 由宿主提供，不对宿主之外的任意写文件行为作跨进程原子性承诺。

## 历史证据（不是 0.11.0 验收）

保留旧文档中的事实范围：2026-10-21 在隔离 DSH_HOME、Desktop 2.0.18/kernel 0.2.1-rc.2 中验证过旧插件安装、命令/API、设置入口和无头 Chromium；2026-10-24 验证过旧版 OpenCode 模型分组；2026-10-25 验证过旧版面板及模型选择器。旧版声称 console 无 error、兼容预检能拒绝不支持版本，这些均不是本次重新执行的结果。

## 0.11.1：受限网络下的官方目录（系统代理）

**反例（0.11.0，2026-11-14 实测）**：本机直连 `generativelanguage.googleapis.com` 在 10.5 秒后以 `UND_ERR_CONNECT_TIMEOUT` 失败，面板因此显示「检查失败：官方目录请求或响应解析失败；保留上次成功目录。」；同一台机器经系统代理 `127.0.0.1:7897` 用同一把 `GOOGLE_API_KEY` 请求 `/v1beta/models` 返回 HTTP 200 与 64 个模型。宿主进程不使用系统代理（`web_fetch` 同样 `TypeError: fetch failed`），所以问题在传输层，不在 Google 适配器。

**改动**：新增 `lib/net-proxy.js`，只替换目录请求的传输，不动设置、凭据与模型写入路径：

- 代理发现顺序：`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`（含小写）与 `NO_PROXY` → macOS `scutil --proxy`（含 `ExceptionsList` 与 IPv4 CIDR）；
- 直连优先：直连失败立即改走代理；直连 2.5 秒未返回则并行对冲，先成功者生效、另一方取消；代理不可用时行为与旧版本一致；
- 只实现 HTTP 代理（https 走 CONNECT + TLS），SOCKS/PAC 明确不支持；
- `lib/sync.js` 的三处请求（官方目录、legacy `/models`、models.dev）统一走该传输；`DSH_MODEL_SYNC_DEBUG_PROXY=1` 输出选路与失败原因。

**验证**：`node --test` 337/337（基线 324 + 新增 13 条：代理 URL/`scutil` 解析、例外域名与 CIDR、CONNECT 隧道、chunked、abort、对冲、回退、直连优先，以及「对冲后两侧都失败必须快速拒绝」「`redirect: 'error'` 下 3xx 必须当传输错误」两条回归）；真实 Google 目录 `source=official-api, pages=1, models=64`，耗时 2.98 秒（改动前为失败）。

**仍未验证**：Windows/Linux 的系统代理（只读环境变量）、SOCKS 与 PAC、需要认证的代理（`http://user:pass@host:port` 已实现但无实机）。Gemini 的**对话**请求由 DSH 自身的 LLM 传输发起，不受本插件影响；如果宿主同样无法直连 Google，对话仍需一个宿主可达的端点。

## 0.12.0：系统代理开关（不需要虚拟网卡）

0.11.1 只解决了「目录拉不到」。用户实际遇到的是更完整的一条链：**Clash 里只开了系统代理、没开 TUN 时，目录能显示，对话补全仍然超时**——因为目录走的是插件自己的 `lib/net-proxy.js`，对话走的是宿主 pi-ai 的 `globalThis.fetch`。

0.12.0 在供应商列表上方加一个开关，开启时重新安装 Harness 自带的 `@deepseek-ai/dsh-http-proxy` 全局 dispatcher：

```js
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy';
const dispose = await installProxyFromEnvironment(new Map([['https_proxy', { value: 'http://127.0.0.1:7897' }]]));
// 之后同一进程里所有 fetch（目录、pi-ai 对话、MCP、web fetch）都走代理
await dispose(); // 恢复到安装前的 dispatcher
```

要点：

- `installProxyFromEnvironment(env)` 的 `env` 是「启动环境快照」，形状是 `env.get(name)?.value`，不是普通对象；空 Map 表示显式直连策略。
- 关闭时安装空 Map，而不是 `dispose()`：否则启动环境里本来就有的代理变量会让「关闭」看起来无效。
- 探测顺序：进程环境变量 → macOS `scutil --proxy`；只支持 HTTP(S)，SOCKS/PAC 报告为未检测到。
- 解析模块时先试裸包名（Harness 的 `@deepseek-ai/*` fallback），失败再从宿主入口向上找 `node_modules`；再失败则降级为「仅目录检查走代理」并在面板说明。
- 安装前做 0.8 秒 TCP 存活探测：代理没在跑时安装显式直连策略并说明原因，而不是把整个进程指向一个死端口。
- 验证：`node --test` 352/352（新增 15 条，含「切换前先归还旧策略」「替换失败也要回到 Harness 自己的路由」）；真实安装后 `fetch('https://generativelanguage.googleapis.com/v1beta/models')` 从 10.5s 超时变为 477ms/200，`dispose()` 后重新超时；OpenAI 端点识别为 `openai-completions` 并经代理收到 401（本机 key 无效，传输已通）。
- 未验证：需要认证的代理（`Proxy-Authorization` 由 Harness 策略处理）、SOCKS/PAC、Windows/Linux 系统代理。
