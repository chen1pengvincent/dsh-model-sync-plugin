# DSH 模型插件 · dsh-model-sync-plugin

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 监控各服务商**上游 `/models`**，列出新增模型；勾选后一键添加到 DSH。**不自动删除、不自动改写、不覆盖你在原生「模型」模块的编辑。**

## 功能

- **检查更新**：启动后自动检查一次（只读），也可在面板手动触发
- **勾选添加**：按 provider 列出上游新模型（默认全选、可取消），点「添加所选」写入 DSH settings
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
2. 勾选想要添加的模型（openrouter 默认不勾选）
3. 点「添加所选」，随后即可在原生「模型」设置和会话模型选择器中使用

多协议模型会自动落到对应路由；若某个新模型无法判定协议，会显示在「跳过」中，不会被错误添加。

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
