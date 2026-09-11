# DSH 模型插件 · dsh-model-sync-plugin

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 监控各服务商**上游 `/models`**，列出新增模型；勾选后一键添加到 DSH。**不自动删除、不自动改写、不覆盖你在原生「模型」模块的编辑。**

## 功能

- **检查更新**：启动后自动检查一次（只读），也可在面板手动触发
- **勾选添加**：按 provider 列出上游新模型（默认全选、可取消），点「添加所选」写入 DSH settings
- **默认收起**：新模型列表默认折叠，只有点击展开后才显示搜索与勾选框，长列表不再干扰界面
- **命令**：会话内运行 `/model-sync check` 只读检查并输出各 provider 新模型数量；`/model-sync status` 查看上次结果
- **搜索/筛选**：支持按模型 id 或名称过滤，`全选 / 清空` 只作用于当前筛选结果
- **纳管开关**：每个 provider 可随时「纳入检查」或关闭
- **多协议自动安置**：混合协议的 provider（如 OpenCode Go）会自动拆分为主路由 + 按协议的合成路由（Anthropic / Responses）
- **下架仅提示**：上游不再提供的模型只提示，不删除
- **写前备份**：每次写入前备份 `settings.yaml`（保留最近 20 份）

## 支持的 provider

| provider | 上游端点 | 默认 |
|---|---|---|
| `deepseek-official` | `api.deepseek.com/models` | 纳管、默认全选 |
| `opencode-go` | `opencode.ai/zen/go/v1/models` | 纳管、默认全选 |
| `kimi-coding` | `api.kimi.com/coding/v1/models` | 纳管、默认全选 |
| `openrouter` | `openrouter.ai/api/v1/models` | 纳管、**默认不勾选**（上游 400+ 模型） |

未配置的 provider 会自动跳过；未知 provider 显示为「未纳管」。

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

## 使用

打开 **设置 → 模型更新**：

1. 「检查更新」拉取各 provider 上游 `/models`，只列出新增模型
2. 点击某个 provider 的「选择要添加的模型（N 个，已选 M）」展开列表，按需搜索并勾选（openrouter 默认不勾选；列表超过 200 行时用搜索缩小范围）
3. 点「添加所选」，随后即可在原生「模型」设置和会话模型选择器中使用

多协议模型会自动落到对应路由；若某个新模型无法判定协议，会显示在「跳过」中，不会被错误添加。

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
- 凭证不落盘、不打印

## 数据与状态

| 路径 | 说明 |
|---|---|
| `~/.dsh/model-sync/state.json` | 上次检查/应用、纳管开关、合成路由账本 |
| `~/.dsh/model-sync/models.dev.json` | models.dev 元数据缓存（24h TTL，用于协议分类） |
| `~/.dsh/model-sync/backups/` | settings.yaml 写前备份（最近 20 份） |

## 已知问题与排查

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

## 生态收录

- 仓库 topics 含 `dsh-plugin`，会被 dshfind、dsh-market 等社区目录自动索引（收录要求：可用 `dsh plugin add` 安装且声明 `dsh.bundle`）
- 本包声明 `package.json#dshWorkshop`（`omdsh-workshop-package/v1`），面向 OMDSH Hub（hub.omdsh.dev）的入库与验证；验证证据见 [`docs/ecosystem.md`](docs/ecosystem.md)
- 声明的可验证能力：命令 `/model-sync check`（只读，不写 settings）
- 兼容基线：DSH kernel `0.1.2-rc.1`（DSH Desktop 2.0.6）

## 开发

```bash
node --test tests/          # 单元测试（引擎 + 控制器）
node scripts/dry-run.mjs    # 真实上游 dry-run：读本机凭证，只读不写
```

依赖 DSH kernel 的公开 seam：`ctx.settings`、`ctx.credentials`、`ctx.webServer`、客户端 `slots`。当前适配内核 `0.1.2-rc.1`（DSH Desktop 2.0.6）。

## 卸载

从 profile 的 `package.json` 中移除 `dependencies` 与 `dsh.profile.bundles` 里的 `dsh-model-sync`，删除 `node_modules` 链接后重启 DSH。已写入的模型条目不受影响，可在原生「模型」模块里自行增删。

## License

MIT
