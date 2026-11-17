# 架构

这份文档写给要改代码的人。它按「一次检查、一次保存、一次代理声明」三条路径讲，最后给出判据与测试地图。

## 1. 分层

```
lib/index.js            宿主半入口：apply(ctx) / inject / name
  └─ lib/controller.js  唯一的状态机与写入口
       ├─ lib/targets.js      「哪些 provider 真的已配置」（权威枚举）
       ├─ lib/discovery.js    协议阶梯 + 并发归属 + transient 重试
       ├─ lib/endpoints.js    地址未知时的兜底地址表
       ├─ lib/plan.js         diff → ops（纯函数，不 IO）
       ├─ lib/state.js        账本 / 快照 / 版本闸
       ├─ lib/http.js         自写 net/tls 客户端（共用出口）
       ├─ lib/bili.js         代理声明（只写 providers 表）
       ├─ lib/gateway/        协议网关（回环监听 + 编解码）
       └─ lib/verify.js       自检判据（纯函数）
lib/client.js           浏览器半：settings.section 面板（无 DOM 注入）
lib/api.js              /model-sync/api 的动词分发
lib/install.js          四处引用 + generation + 符号链 + 回验
lib/rollback.js         外科式还原
```

依赖方向是单向的：`controller` 认识所有人，其他人不认识 `controller`。`plan.js`、`verify.js`、`state.js`、`gateway/protocol.js` 不产生 IO，所以可以在测试里直接喂数据。

## 2. 三条路径

### 2.1 检查：从「哪些路由真的已配置」开始

```
settings.describe({redactSecrets:true})   ← 唯一真相：配置里有什么
llm.listConfigurableProviders()           ← 注册表：DSH 认识哪些（≠ 已配置）
        ↓ 交集
lib/targets.js:configuredTargets()
        ↓ 每条路由
baseURL = profile.baseURL ?? 环境变量 ?? defaultBaseURL ?? 地址表
protocol = profile.api ?? 端点协议
        ↓
lib/discovery.js:listAll()  → 协议阶梯（依次试四种协议的列举端点，记录归属）
        ↓
controller.checkOne()  → { status, upstream[], added[], removed[], attribution }
```

两个坑必须记住：

- **注册 ≠ 已配置**。只有在配置里真的存在 `settingsPath` 指向的对象，这条路由才算存在。否则你会在面板里给一个从未配置的供应商「加模型」。
- **协议是「问出来的」，不是查表得来的**。`sharedCatalogApi()` 只在路由的目录模型恰好同属一种协议时才给答案，跨协议时返回 `undefined`。所以归属必须靠真请求判定；这也是 0.x 那个 12 MB 的 `models.dev.json` 在 2.0 里被删掉的原因。

### 2.2 保存：没有第二条写路径

```
面板（草稿）→ POST /model-sync/api/apply {provider, ids}
        ↓
controller.apply()
  ├─ 重新读配置（绝不重放旧计划：那会重建别人刚删的键）
  ├─ plan.js:diff()  → ops（只允许 ['providers', X, 'models']）
  ├─ state.snapshot('before-apply')   ← 写前留证
  ├─ settings.mutate(ns, ops, revision) ← 唯一提交点
  └─ 409 → 重算并重试一次（仍是 409 就把原因给人看）
```

几条纪律：

- **只写 `models`**。例外只有三处，且都写前快照：删除上一版留下的合成键（`unset`）、网关写 `baseURL`/`api`、混合协议路由「收拢」时写 `api`。
- **删到最后一个模型时写 `unset`**。pi-ai 把 `models: []` 和「没有列表」看成同一件事，写空数组会让整张内置目录回来。
- **冲突不重放**。revision 冲突时按最新配置重新计算；重放旧 op 会凭空重建 provider 键。
- **快照脱敏**。`describe({redactSecrets:true})` 只藏 schema 标了 secret 的字段，而 `headers` 是普通字符串表，所以快照前把 header 值全部替换为 `***`，文件 0600。错误文本里的 query 值也会去掉（有的网关把 key 放在 `?key=`）。

### 2.3 代理声明：只碰自己的键

```
系统代理存在？ ──no──→ 什么都不做（并且撤销上次写的）
   │yes
locate()  → proxy-origin 验 pid → 回落 port-zone.json
   │
需要代理的主机 = 已配置路由的 baseURL 主机 ∩ {google, openai, anthropic}
   │
planProviders(config, hosts, proxy)  ← 纯函数：只算 providers 表，其余键原样带回
   │
备份 → PUT /__bili/config {providers} → 回读校验 proxy === url → 记账（首条优先）
```

为什么不能用 `fetch` 或 `node:http`：本机 `NODE_USE_ENV_PROXY=1` 会劫持 `http.request`（CONNECT 会挂住 60 秒），而 `fetch` 会被别的插件改写成回环地址。所以 `lib/http.js` 自己写 socket：HTTP 代理用 CONNECT 隧道、SOCKS 明确拒绝（不静默直连）、响应头有字节上限（64 KiB）、SSE 按三种框架（`content-length` / `chunked` / 读到关闭）流式读出。

## 3. 协议网关

网关是**可选**的一层，只在「上游有、DSH 目录里没有的模型 id」时才有意义。

```
DSH ──POST /g/<route>/chat/completions──→ 网关（127.0.0.1）
                                            ├─ model 归属 == 入站协议 → 逐字节透传
                                            └─ 否则 decodeRequest → encodeRequest(上游协议)
                                                       ↑ SSE        ↓ SSE
                                                createStreamDecoder / createStreamEncoder
```

- 规范请求/事件是中间表示：`{model, system, messages:[{role, parts}], tools, stream}` 与 `start | text | thinking | tool-call-* | usage | finish | error`。
- 四种协议：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。
- 无损边界：跨协议时 thinking 签名、`cache_control`、responses 的 reasoning item 会丢（上游 SDK 自己也丢）；Gemini 没有 tool id，只能按函数名回指。
- 上游出口**不复用**入站连接，也不走 `fetch`：`lib/http.js` + 系统代理，只对需要代理的主机生效。
- 撤销守卫：路由里还有「靠收拢才存在」的模型时拒绝撤销，先把它们移除。

## 4. 面板

- 只注册一个 `settings.section`（`id: model-sync`），不注入 DOM、不覆写别人的 slot。
- 卡片是受控的：`drafts[provider] = {add:Set, remove:Set}`，所有写入都必须先变成草稿。
- **回调签名是契约**：`textButton` 包装成 `onClick: () => onClick()`，绝不把事件对象透给期望业务参数的处理器（0.x → 2.0 的「清空点了没反应」就是这么来的）。
- 三个不可逆按钮走两次点击（`confirmed` + 6 秒自动撤）。

## 5. 状态文件

```
<profile>/model-sync/
  state.json                  version: 1，账本（检查结果、草稿不落盘、自检结论、代理记账）
  snapshots/                  before-apply / before-prune / before-gateway（保留 20 份）
  bili-config-<ISO>.json      每次写外部配置前的整份备份
```

- `version !== 1` 或 JSON 损坏 → 归档成 `state.json.rejected-<ISO>.json` 并在面板提示；**全新安装**（文件不存在）不归档，直接空账本起步。
- 同一时刻只跑一次自检（promise 去重），否则启动那次与点击那次会互相覆盖结论。

## 6. 判据与测试地图

| 层 | 文件 | 看什么 |
| --- | --- | --- |
| 纯函数 | `test/state`、`plan`（并入 controller 用例）、`verify`、`gateway-protocol` | 不碰 IO，喂数据断言输出 |
| 控制器 | `test/controller`（最大一份） | 假 settings + 假 llm，断言「写了什么、没写什么」 |
| 网关 | `test/gateway-server`、`gateway-route`、`gateway-gemini` | 假上游 + 真 HTTP，断言帧序列 |
| 面板 | `test/client-bundle`、`panel-integration`、`panel-actions` | 契约、真实 view 渲染、点击后状态（迷你 hook 运行时） |
| 安装 | `test/install`、`rollback` | 假 `DSH_HOME` 里真跑一步 |
| 启动 | `test/restart`、`smoke` | 同一状态目录跑两次控制器 |

写作约定：假宿主的结构必须从真实 schema 抄；测试接缝必须 fail-closed（缺写入器就抛错，绝不「有 A 用 A 否则退回真实实现」——这条是踩过事故之后写下来的）。
