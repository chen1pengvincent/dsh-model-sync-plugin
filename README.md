# dsh-model-sync

> 让「你已经配好的供应商」的模型清单跟着上游走：定期问一句「你现在有哪些模型」，由你在设置面板里逐项确认，然后只改那一条路由的 `models` 数组——**永不新增供应商**。新模型的上下文窗口、最大输出、推理档位和输入能力会自动补全；聚合来源的信息集中在「待确认模型信息」里，可改、可撤销，官方来源出现后自动覆盖。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 写的第三方插件，不是 DeepSeek 官方项目。

- 当前版本 **2.2.0**（见[为什么是 2.0](#为什么是-20)）
- 声明兼容 DSH kernel `>=0.2.2-rc.1 <0.3.0-0`，在 `0.2.2-rc.3` 上实测
- 零新增运行时依赖。对话显示适配支持 DSH Desktop `0.2.2-rc.3`。
- MIT

---

## 这个插件解决什么

DSH 的模型目录是**构建期的静态表**，上游发布的新模型不会自己出现。

官方的 `discoverModels` 只服务于「你刚填完 API key 这一次」：对一个已经配置好的供应商，它直接返回内置目录，**不发任何网络请求**。所以你会遇到两种局面——上游已经有了新模型，而你的模型选择器里没有；或者上游下架了某个模型，而清单里还留着它。

本插件补上这一格：

1. 按每条已配置路由的协议，问上游要一份真实目录；
2. 和本地实际生效的清单求差；
3. 把差异放进面板，**你点确认之后**才写回配置。

## 三条不变量

整套设计都服务这三条，它们比功能更重要：

| # | 不变量 | 为什么 |
| --- | --- | --- |
| 1 | **永不创建 provider 键** | DSH 里只要多一个 provider 键，设置页就多一张卡、模型选择器就多一个分组。那正是「插件把供应商摆到用户面前」——用户应该无感 |
| 2 | **可见性只写你确认过的东西** | 模型显示/隐藏仍由你点保存触发；元数据可自动补全并带来源、可撤销；`input` 能力只补空值，非空值为用户固定；聚合来源只补空白，官方来源优先级最高、可覆盖用户值；上游下线**从不自动删** |
| 3 | **写前留快照，写后可还原** | 每次写入前把 `describe({redactSecrets:true})` 存进 `snapshots/`（保留 20 份）；在 DSH 官方设置中管理现有模型清单 |

## 为什么是 2.0

0.x 有两种做法在原理上就不成立，2.0 把它们换掉了：

| 0.x 的做法 | 为什么不行 | 2.0 换成了 |
| --- | --- | --- |
| 为每种协议造一个供应商键（`<base>-chat` / `-messages` / `-responses`） | 这些键会**永久出现在官方模型选项里**，用户要在本该干净的列表里挑「同一个供应商的三种人格」 | 一条路由服务多协议靠 DSH 自己的目录；目录外的新模型交给**本地协议网关**按 `model` 翻译，不新增任何键 |
| 在 harness 里装全局 HTTP dispatcher 来「让模型走代理」 | 模型请求**根本不在 harness 里发**：`fetch` 被别的插件改写成回环地址，再由一个代理环境被清空的子进程重发。装在 harness 里的 dispatcher 够不到这一跳 | 改为往那个子进程的**策略表**里写一条 `providers.<主机>.proxy` 声明，可撤销、只碰自己的键 |

顺带重写的还有：面板不再注入任何 DOM（只占一个 `settings.section` 槽位）、状态文件带 `version` 闸（拒绝跨版本读取，损坏时归档而不覆盖）、测试从「渲染出来长什么样」变成「点下去之后用户看到什么」。

## 五条诉求，五个能力

### 1. 选择对话模型

打开 DSH「设置 → 模型管理」。

- 点「立即检查」刷新模型清单。展开服务商后，可按厂商浏览，或搜索模型名称与 ID。
- 展开服务商后可「全选」或「全不选」。两项操作都针对当前服务商的整张清单，筛选后也可单独「勾选筛选结果」。
- 勾选要显示的模型后点「保存模型选择」，对话下拉框和 `/model` 会更新。新模型所需的 DSH 配置也会在这次保存中写入。
- 取消勾选会从下拉框和 `/model` 隐藏模型，已有会话、默认模型和配置仍可使用。
- **设置 → 模型**。在 DSH 官方页面修改参数、停用或移除模型。

### 2. 自动补全模型元数据

DSH 模型条目里最难手填的是 `contextWindow`、`maxTokens`、`reasoningEfforts` 和 `input`。插件的策略是：

- 只对**已经显式配置在 `models` 数组里的模型**补字段，不对继承目录做物化；
- 聚合目录只补空白字段，不覆盖你手写的值；官方来源优先级更高，可以覆盖手写值；
- 官方值优先：供应商原生 `/models`（以及 OpenRouter 的 `reasoning.supported_efforts`）给出的字段直接写回；
- 聚合目录兜底：`models.dev` 只做**精确 provider + model** 匹配，绝不跨 provider 抄数值；其 canonical 信息只用于家族/模态展示；
- `input` 只写 DSH 能表达的 `text`/`image`，`audio`/`video`/`pdf` 会丢弃；空值/空数组才补，用户写下的非空 `[text]` 不会被扩成 `[text,image]`；
- 点「自查」或「检查更新」会强制拉取一次 models.dev（不走 24h 缓存），把本轮学到的字段直接写回，并在面板显示更新数量；启动时只走一次，避免双写竞争；
- 拿不准就留空，不猜。`reasoningEfforts` 只映射 DSH 支持的命名档位；`toggle`/`budget` 类型不硬塞。

### 3. 待确认模型信息

设置 → 模型管理 → 页头右侧的「待确认模型信息」子 Tab。第一 Tab 的供应商/模型勾选界面保持原样，只在标签旁多一个动态数量徽标。

- 这里列出仍带**非官方来源**字段的已配置模型；全部字段都被官方确认后会自动消失。
- 橙色说明条、搜索、状态/置信度/字段/来源筛选、按供应商/状态/缺字段/家族/模态聚类，模型卡默认收起。
- 展开后可看到上下文窗口、最大输出、推理档位、输入能力，以及每项的来源、置信度和更新时间；可逐项修改，也可撤销插件补全。
- 官方来源优先级最高：一旦出现，直接覆盖插件值和用户手写值（包括在 DSH 设置里直接改的值），并从本 Tab 移出；聚合目录的兜底值不会覆盖手写值。
- 聚合目录加载失败时保留最近一次缓存并在本地降级，不会因为目录不可用而清空已有字段。

### 4. 定时拉上游

默认**每天 09:00** 自动检查一次（面板里可改时间或关掉）。检查会读上游、补全上述空白元数据字段，并把结果写入状态文件；**模型显示/隐藏仍等你点保存**。点「自查」或「检查更新」时还会强制刷新 models.dev 并立即写回，不等下一次定时任务。

检查的协议来自路由本身，不猜：`openai-completions` / `openai-responses` → `GET {base}/models`；`anthropic-messages` → `GET {root}/v1/models`；`google-generative-ai` → `GET {base}/models?pageSize=…`。地址未知时卡片显示灰色的 `无法检查` 并**一个请求都不发**；推送一次性抖动（走代理时 TLS 握手被掐断）会自动重试一次。

### 5. 开了代理时，需要代理的模型走代理

这不是「在 harness 里开个开关」就能解决的事——见上面的表。插件做的是：

- 只读地发现那个子进程（`~/.local/state/billion-context/proxy-origin` 验 pid 存活 → 回落 `port-zone.json`）；
- 读它的配置，只改 `providers` 表里 `generativelanguage.googleapis.com` / `api.openai.com` / `api.anthropic.com` 这几条的 `proxy` 字段，其余键原样带回；
- 写前整份备份到 `<profile>/model-sync/bili-config-*.json`，写完回读校验；
- **只在开着系统代理时写**；系统代理消失、功能关闭、子进程不在，一律降级成「什么都不改」——因为把请求钉死在一个已经挂掉的代理上，比不留更糟；
- 「撤销」只删自己写过的键、恢复原值；如果那条声明不是你写的，面板会注明（`不是本插件写的，撤销不会删`）。

面板上的域名是**从你配置的 provider 现算的**，不存在可编辑的覆盖列表。

> 粒度提醒：出口是**主机**的属性，不是模型的属性。真要按模型分流，用协议网关——那时出口由网关决定。

## 安装

本插件通过 profile 的 bundle patch 加载（`cordis.patch.yml` 里一行 `insert`），宿主半与浏览器半在同一个包里。

```sh
node scripts/install.mjs --profile desktop           # 干跑：打印现状 & 计划，不改任何东西
node scripts/install.mjs --profile desktop --apply   # 执行
```

它写**四处引用**：`dependencies`、`pnpm.overrides`、`dsh.desktop.generationProjection.plugins`、`dsh.profile.bundles`，再建 generation 目录与 `node_modules` 符号链，最后逐条回验；任一条不生效就写 `model-sync-install-failed.txt` 并报错。

**为什么要脚本而不是 `dsh plugin add`**：`desktop` 是保留 profile（CLI 按名字硬拒），而随应用打包的 pnpm 也动不了这棵树（store 版本不匹配会直接中止）。既然 `link:` 依赖最终只是「`package.json` 里一行 + `node_modules` 里一个符号链」，脚本就直写这两件事，不碰包管理器。

装完**重启 DSH**。旧版的状态目录会被改名成 `model-sync.legacy-<时间>`（不会被误当成新版账本读出），重跑幂等。

### 试用 2.2.0 模型元数据分支

`preview/p1-model-metadata` 分支包含模型元数据能力：models.dev 精确供应商匹配、推理档位全档映射、输入能力补全、来源/置信度、自动补全、官方来源覆盖，以及「待确认模型信息」子 Tab；「自查/检查更新」会强制刷新 models.dev 并直接写回。第一 Tab 的供应商与模型勾选界面保持原样，只在页头增加两个子 Tab 和动态数量徽标。

```sh
git clone --branch preview/p1-model-metadata https://github.com/chen1pengvincent/dsh-model-sync-plugin.git
cd dsh-model-sync-plugin
node scripts/install.mjs --profile desktop --apply   # 或 --profile web
```

装完重启 DSH。2.2.0 起，启动后首次自查会拉取 models.dev 并写入可确认的元数据；试用后发现问题，请在该分支提 issue，并附上 DSH 版本、路由类型和「待确认模型信息」截图；不要直接在真实 profile 上手工改 `model-sync/state.json`。

## 本地选择器适配

安装脚本加载插件面板。要在 DSH `0.2.2-rc.3` 使用对话显示，再从该版本的 app.asar 解包目录生成 profile 级适配，随后重启 DSH。

```sh
DSH_ASAR_DIR=/path/to/extracted/app node scripts/selector-overlay.mjs --apply desktop
```

可用 `node scripts/selector-overlay.mjs --remove desktop` 移除 profile 级适配配置，重启后恢复官方选择器加载方式。显示偏好仍保留在 profile 的 `model-sync/state.json`。


## 协议网关（默认关闭，按路由开）

只有一种情况需要它：**上游有、DSH 目录里没有**的模型 id。这类 id 没有自带协议，而一条路由只能给一种协议，于是 DSH 会报 `model "X" needs an api`——注意它不是只拒那一个模型，而是整条路由解析失败。

打开后：

| 项 | 行为 |
| --- | --- |
| 绑定 | 只绑 `127.0.0.1`，端口由内核分配；永不使用别的插件占用的端口 |
| 写什么 | 该路由的 `baseURL = http://127.0.0.1:<port>/g/<route>`；跨多种协议时再加一个 `api = '<收拢后的协议>'`。其余字段不动，写前快照 |
| 同协议请求 | 逐字节透传，body 不重写 |
| 异协议请求 | 解码 → 按上游协议重编码 → 把上游 SSE 重新编码回入站协议（四种协议六向） |
| 未探测到的 model | 按入站协议透传（猜一个协议只会把能用的请求变成 501） |
| 密钥 | 不落盘、不进状态文件；透传用入站的头，缺了才补路由自己的 |
| 鉴权 | 路由说了算：有的供应商讲 anthropic 协议却用 bearer，编码器之后会再叠一层路由声明的头 |
| 还原 | 「停止转发」一键恢复原 `baseURL`；若你手工改过它，会拒绝而不是覆盖 |

真实上游验证过五个方向（同协议透传、completions⇄anthropic、completions→Gemini，以及「收拢后只剩 completions 的路由上跑 Gemini 模型」），全部 200 且返回文本。假上游的用例只证明协议形状，这几条才算端到端。

## 它不做什么

- 不注册 provider、不改 `displayName` / `baseURL` / `apiKeyEnv`（网关与清理合成键除外，且都写前快照）
- 不替你切模型、不改默认模型
- 不缓存你的 API key（`snapshots/` 是脱敏副本，文件 0600）
- 不注入 DOM、不覆写别人的 slot
- 不自动删除任何模型（上游下线只提示）
- 不自动改变模型可见性；自动写入仅限空白元数据字段，且可在「待确认模型信息」里撤销

## 自检与彩排

```sh
node scripts/verify.mjs                                  # 只看磁盘：四处引用、账本、代理声明
node scripts/boot-graph.mjs                               # 用宿主自己的解析器验证「重启后面板一定有座位」
node scripts/verify.mjs --url http://127.0.0.1:<端口>      # 再加上运行中的实例
node scripts/rehearse.mjs                                 # 对着真 profile 彩排（写入换成录音机）
```

插件**启动时会自己跑一次自检**，结论写在面板顶部（重启后的第一个问题不用点按钮就有答案）。面板右上角的「自检」按钮跑的是同一套判据（`lib/verify.js`），同一时刻只跑一次，避免两次结论互相覆盖。

## 升级、回滚

- **从 0.x 升级**。如果看到「待核对的旧版路由」，请在官方模型设置核对配置归属和引用。面板保留这些路由。详见 [升级说明](docs/upgrading-from-0.x.md)。
- **回滚**：`node scripts/rollback.mjs`（干跑）→ `--apply`。它只还原三处引用与符号链，**不整份覆盖 manifest**（那会连带删掉备份之后装的其它插件），执行前自己留一份备份，所以回滚也可逆。
- 插件自身状态在 `<profile>/model-sync/`（`state.json` + `snapshots/` + `bili-config-*.json`），删掉即完全还原。

## 测试

```sh
node --test
node scripts/live-discovery.mjs   # 真实网络：对已配置供应商各拉一次目录（只读）
node scripts/live-gateway.mjs --route <id> [--mode reverse]   # 真实上游跑一遍网关
```

测试覆盖目录检查、模型加入、显示偏好持久化、版本冲突、协议网关、安装回滚，以及 models.dev 精确匹配、元数据自动补全、编辑/撤销和来源覆盖。

## 目录

```
lib/index.js          宿主半入口（apply / inject / name），只注册一个 settings.section
lib/client.js         浏览器半：设置面板（无 DOM 注入）
lib/controller.js     状态机与全部写入口（check / apply / remove / restore / prune / gateway / bili）
lib/targets.js        权威「哪些 provider 真的已配置」+ 合成键识别
lib/discovery.js      协议阶梯、并发归属、transient 重试
lib/plan.js           diff → 只产 ['providers', X, 'models'] 的 op
lib/state.js          账本、快照、版本闸
lib/http.js           自写 net/tls 客户端（HTTP 代理隧道、SSE 流）
lib/bili.js           发现车道、只写 providers 表、精确撤销
lib/gateway/          server.js（回环监听 + 双路径转发）、protocol.js（四种协议编解码）
lib/verify.js         自检判据（纯函数）
lib/install.js        四处引用 + generation + 符号链 + 回验
lib/rollback.js       外科式还原
scripts/              安装、回滚、自检、彩排、真机目录、真机网关
docs/                 架构说明、从 0.x 升级
```

## License

MIT
