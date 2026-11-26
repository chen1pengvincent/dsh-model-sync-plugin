# 架构与设计沿革

模型管理要回答三个独立的问题：供应商现在提供哪些模型，用户希望在对话中看到哪些模型，各字段的值有什么依据。供应商目录、DSH 的实际配置、用户选择分别保存。上游少返回一个 ID 可以触发提示，不能据此删除已配置的模型。一次目录检查可以按来源规则补全字段，模型的显示和隐藏由用户保存。

## 设计沿革

截至 `b9b6a83`（v3.1.3），GitHub 主线有 54 次提交、16 个版本标签。仓库的全部状态 PR 列表为空。预览分支的 `c028dc3` 已在主线历史内。以下依据提交差异、提交说明和仍在使用的入口还原设计决策。[提交历史](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commits/b9b6a83/) · [全部 PR](https://api.github.com/repos/chen1pengvincent/dsh-model-sync-plugin/pulls?state=all)

| 阶段 | 当时的问题和选择 | 对当前实现的影响 |
| --- | --- | --- |
| 0.2–0.10 | 早期通过额外的协议子路由让同一服务商支持多个协议。子路由出现在官方卡片和选择器后，陆续加了隐藏卡片、嵌入原生列表和按组展示。[初版](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/4275f9c) · [协议子路由](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/38f21f4) · [嵌入官方列表](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/d324131) | 创建和遮蔽卡片的实现已随 v2 重写退出。旧 profile 仍可能有同名键，也可能由用户手工创建，因此保留只读提示和旧账本归档。 |
| 0.11–0.12 | 固定名单逐步改为从宿主发现已配置供应商。为让聊天使用系统代理，插件曾修改宿主全局 dispatcher，随后又需处理启动策略、凭证及卸载顺序。[动态发现](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/cbdc9a8) · [全局代理](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/150fdf3) · [卸载修复](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/ce931e6) | v2 重写记录了失效前提：实际聊天出口可以在另一个进程。当前目录请求自行选择出口，聊天所需声明通过 bili 单独对账。 |
| 2.0–2.0.1 | 不再创建供应商键。普通路由使用原协议，目录外模型确需转换时才启用回环网关。随后把“已登记”和“对话可见”拆开，恢复成单一勾选清单。[重写说明](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/acb81bf) · [可见性决策](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/3040461) · [统一清单](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/8cee92a) | 有意保留四种协议、原生选择器适配及会话使用量检查。隐藏模型可以保留历史会话使用的配置。 |
| 2.2–3.1.2 | models.dev 重新用于补参。精确的供应商和 ID 匹配能提供候选，相同家族只能提供展示信息。复核和历史随后加入逐字段来源、锁定、忽略和路由身份校验。[元数据预览](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/4c8096a) · [强制刷新](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/c028dc3) · [复核与同步历史](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/d265151) · [3.1.2](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/b35ee8f) | 保留主动刷新和失败时读取旧缓存的能力。保留用户拒绝过的字段记录，防止启动时重新补回。协议归属仍由协议探测决定。 |
| 3.1.3 | Desktop 和 Web 可以同时管理同一 bili 出口。跨进程锁、共享账本、探测及写后回读用于区分归属和识别失效代理。[出网修复](https://github.com/chen1pengvincent/dsh-model-sync-plugin/commit/b9b6a83) | 定时对账仍有职责。每次观察只需查受管主机；获取自身进程启动标识可以复用，判断其他进程是否仍拥有旧锁则需要实时查询。 |

## 运行路径

**目录检查。** `targets.js` 将宿主注册表与 `settings.describe({redactSecrets:true})` 的有效配置连接，再用 `llm.listModels(provider)` 确认可用模型。限定单一供应商时，其他供应商的目录和凭证都可以跳过。`discovery.listModels()` 依次尝试协议阶梯，成功即返回。网关需要知道每个模型的协议归属，才使用 `listAll()`。批量校验共享本次读取的宿主目录，下一次保存会重新读取。路由身份绑定端点及凭证信息的摘要，避免把旧供应商的证据当成本路由的依据。

**保存与撤销。** `controller.js` 编排写入，`plan.js` 生成模型列表的变更。提交前读取最新配置，带 revision 调用 `settings.mutate`，保留写前快照。原生选择器通过可见性 API 读取 `[provider, id]` 隐藏清单。模型字段的复核要求路由、revision、候选来源和值仍与预览一致。账本落盘失败时，字段回滚先确认宿主版本和插件刚写入的内容。旧的 `prune` 请求返回 409；另一个 `cleanup` API 只接受显式指定且宿主注册表未识别的键，面板仅展示待核对项。

**面板与自查。** `lib/client.js` 只注册一个 `settings.section`。模型选择、字段复核分别使用草稿，第三页显示同步历史。`lib/model-metadata.js` 负责字段规则，以及从当前路由和账本生成复核行和历史。面板 API 保留原有 `metadata` 和 `review` 返回结构。自查共用诊断字段，单独获取最新供应商、网关和 bili 状态；启动等待供应商注册时只重读路由。打开面板或保存选择时，仍按需读取会话使用量。宿主挂载路由后，首次 API 请求等待本地账本加载，不必等待网络目录刷新。

**协议网关。** `lib/gateway/server.js` 在首次启动网关时加载。四种协议的名单由 `protocols.js` 提供；`protocol.js` 只在跨协议请求中加载。相同协议逐字节转发，跨协议请求才经过请求、事件和 SSE 编解码。共享中间表示涵盖消息、工具和流式事件。跨协议能力受目标协议限制，例如 Gemini 的工具结果按函数名关联。网关写回前重新核对供应商、端点及协议；路由在操作途中被删除时保留删除结果。撤销时恢复原本显式配置或继承的地址。还有依赖协议收拢的模型时，撤销路由会被拒绝。宿主卸载时关闭监听器，清理定时器；下游停读或断开时，向上游传递背压或取消。

**出网。** `lib/http.js` 使用 net/tls socket，使目录读取和网关转发独立于宿主的全局 dispatcher、fetch 改写和其他插件。HTTP CONNECT、响应大小上限与三种响应体分帧均有专门测试。网关从缓存的健康状态选择出口。`lib/egress/` 独立处理声明的观察、决策、加锁、执行和回读；受管变更执行前备份配置。手工代理探测失败时保留原值。bili 的 60 秒首轮熔断冷却由 bili 自己维护。

## 持久化与升级

| 位置 | 内容和约束 |
| --- | --- |
| `<profile>/model-sync/state.json` | 版本 1 账本，含检查结果、显示选择、字段来源、历史和自查结论。写入串行化并以临时文件原子替换。旧版本或损坏的 JSON 会尝试归档并提示，从未安装过的 profile 直接使用空账本。 |
| `<profile>/model-sync/snapshots/` | 最近 20 份配置快照。宿主脱敏之外再遮蔽 header 值，以 0600 权限写入。 |
| `<profile>/model-sync/models.dev.json` | 原始公共目录和获取时间。有效刷新成功后写入新缓存，刷新失败可继续显示旧数据的时间和状态。 |
| `~/.dsh/model-sync/` | Desktop 和 Web 共用的出网账本与锁。测试通过 `DSH_MODEL_SYNC_EGRESS_DIR` 指向临时目录。 |

`lib/install.js` 与 `lib/rollback.js` 管理 profile 引用、generation 和链接。旧 profile、多个 profile 共享 generation 以及本地已有凭证都是当前支持的输入，不能因为新装路径更简单就删掉对应保护。

## 本次重构的依据

已经移除三类遗留：没有仓内调用或包导出的旧方法（独立代理选择、元数据值标签、快照读取），只为读取首项却常驻整组对象的 canonical 索引，以及会按最新 revision 盲目覆盖模型列表的旧元数据回滚。它们所承载的现行职责分别由请求传输、字段投影、磁盘快照、首条展示候选和带版本的回滚路径承担。

以下计数来自相同离线输入，对照基线 `b9b6a83`。前四行使用 8 条路由、每条 100 个模型、20 个会话，其中一条路由匹配受管代理主机；两版的完整面板 JSON、受管主机列表和自查结论逐项相等。

| 操作及计数单位 | 基线 | 重构后 |
| --- | ---: | ---: |
| 打开面板，宿主模型目录读取 | 16 | 8 |
| 一次后台受管主机枚举，宿主目录读取 / 凭证解析 | 8 / 8 | 1 / 0 |
| 一次自查，宿主模型目录读取 | 104 | 32 |
| 一次自查，会话投影 / 快照列表读取 | 40 / 2 | 0 / 0 |
| 一条路由有 100 个新增候选、500 个宿主模型，单次检查读取宿主内置目录 | 101 | 1 |
| 5,000 条目录记录，强制刷新成功时读取旧缓存的字节数 | 5,356,731 | 0 |
| 2 MiB 目录按 128 段经本机 TCP 返回，Buffer.concat 累计分配字节数 | 132,431,820 | 2,097,152 |
| macOS 同一进程连续获得出网锁 12 次，启动 /bin/ps 的次数 | 12 | 1 |

这些数字度量指定操作。用户机器上的 CPU 占用和常驻内存还取决于目录规模、路由、会话数及网关流量。

## 验证入口

- `node --test` 覆盖状态升级、安装回滚、面板渲染与点击、跨协议事件、流读取、断线回收和两个 profile 共同对账。bili 对账的常规测试使用隔离 fixture。
- `test/targets.test.mjs`、`test/check.test.mjs` 和 `test/models-dev.test.mjs` 覆盖筛选、宿主目录读取次数、候选有效性及缓存回退。
- `test/controller.test.mjs`、`test/restart.test.mjs` 和 `test/gateway-route.test.mjs` 覆盖字段事务、并发修改、启动顺序和卸载。
- `test/boot-graph.test.mjs` 配合宿主载荷，验证宿主解析到当前源码的浏览器入口。真实 bili 的两项联测经 `DSH_MODEL_SYNC_TEST_LIVE_BILI=1` 单独启用，其中一项会写入运行中的实例。

在安装了 DSH 的 macOS 上，可以用应用自带的 Node 运行时直接读取 app.asar，验证当前 checkout 的面板入口。

```sh
DSH_APP="/Applications/DeepSeek Harness.app"
ELECTRON_RUN_AS_NODE=1 DSH_ASAR_DIR="$DSH_APP/Contents/Resources/app.asar" \
  "$DSH_APP/Contents/MacOS/DeepSeek Harness" --test test/boot-graph.test.mjs
```
