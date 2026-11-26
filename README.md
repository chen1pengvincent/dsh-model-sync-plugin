# DSH Model Sync

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的「设置 → 模型管理」里检查供应商目录、选择对话可见模型、核对模型参数。这是第三方插件，只管理你已经配置的供应商。模型显示和隐藏以你保存的选择为准。上游下架的模型会提示核对，已有配置会保留。

[下载 v3.1.4](https://github.com/chen1pengvincent/dsh-model-sync-plugin/releases/tag/v3.1.4) · [版本记录](CHANGELOG.md)

## 安装或升级

macOS 上需要 Node.js。插件声明的 DSH 内核兼容范围为 `>=0.2.2-rc.1 <0.3.0-0`。对话选择器适配支持 `0.2.2-rc.3` 和 `0.2.2-rc.5`。

退出 DSH，将源码放在长期保留的位置。安装通过本地链接加载源码。

~~~sh
git clone --branch v3.1.4 https://github.com/chen1pengvincent/dsh-model-sync-plugin.git
cd dsh-model-sync-plugin
node scripts/install.mjs --profile desktop
node scripts/install.mjs --profile desktop --apply
~~~

第一条安装命令预览变更，第二条执行。升级会保留兼容的模型选择、定时设置和同步记录。

首次使用对话模型显示和隐藏功能时，为 Desktop profile 安装原生选择器适配。已有适配的用户可以直接重启 DSH。

~~~sh
DSH_APP="/Applications/DeepSeek Harness.app"
ELECTRON_RUN_AS_NODE=1 DSH_ASAR_DIR="$DSH_APP/Contents/Resources/app.asar" \
  "$DSH_APP/Contents/MacOS/DeepSeek Harness" scripts/selector-overlay.mjs --apply desktop
~~~

打开 DSH，进入「设置 → 模型管理」。如果面板提示需要加载选择器适配，检查上一步是否成功，再完全退出并重启 DSH。使用 Web profile 时，将安装命令中的 `desktop` 换成 `web`，并重启该实例。

## 日常使用

### 模型管理

点「检查更新」查看各供应商的上游目录和检查结果。可按供应商或厂商浏览，也可以搜索模型名称、ID 或供应商。勾选后点「保存模型选择」，对话下拉框和 `/model` 才会更新。隐藏模型会保留配置及已有会话。

在「连接设置」里可以调整定时检查。默认每天 09:00 检查一次，并按来源规则补充可确认的字段。

### 待确认模型信息

左侧列表展示模型名称、ID、供应商、当前问题和信息状态。用上方的搜索、筛选和排序定位模型，然后在右侧核对上下文窗口、最大输出、输入模态和推理档位。可用「使用候选值」填写有来源的参数，并在「预览并保存」中核对实际变更。

- 「保留我的值」会锁定对应字段。官方值与当前值有差异时，继续提醒你确认更新。
- 「忽略本次」收起普通提醒。对应上游值变化后会重新提醒，官方值差异会持续显示。
- 「撤销补全」可撤销符合条件的自动补全字段。
- 可登记文本、图像、音频、视频和 PDF 五种输入模态。当前 DSH 会话可发送文本和图像。

**当前状态**描述缺字段、字段差异或路由问题。**信息状态**描述参数证据的完整程度。官方 API 返回模型 ID，只确认该模型出现在当前路由的目录中。参数需要逐项看来源。

| 字段来源 | 含义 |
| --- | --- |
| 官方 API | 当前供应商路由实际返回的参数 |
| DSH 内置目录 | 随本机 DSH 安装的模型资料 |
| models.dev 精准匹配 | 同时匹配供应商与模型 ID 的参数候选 |
| models.dev 泛化 | 家族等辅助信息，仅用于展示 |
| 人工填写 | 你在 DSH 设置或复核面板中填写的值 |

旧账本中无法区分历史官方回答与本机资料的值，显示为「本机已确认」。

### 同步历史

查看目录检查、发现模型、字段修改、显示选择和人工处理记录。可以从记录跳回仍存在的模型。

## 诊断与回滚

- 要查看运行状态，点面板里的「自查」。也可执行 `node scripts/verify.mjs --profile desktop` 检查安装引用和状态文件。
- 目录外模型需要协议适配时，按供应商在「维护与诊断」中启用协议网关。系统代理声明可在面板里查看或撤销。
- 从 0.x 升级时，如果出现「待核对的旧版路由」，按[旧版升级说明](docs/upgrading-from-0.x.md)核对归属。

需要恢复上一版插件时，先退出 DSH，再预览并执行回滚。

~~~sh
node scripts/rollback.mjs --profile desktop
node scripts/rollback.mjs --profile desktop --apply
~~~

回滚会恢复安装引用。已保存的模型配置仍在 DSH 设置中，可按需核对 `<profile>/model-sync/snapshots/` 下的写入前快照。

## 开发

运行 `node --test`。提供已解包的 DSH 载荷时，可设置 `DSH_ASAR_DIR` 运行宿主加载测试。实现细节见[架构说明](docs/architecture.md)。

[MIT 许可证](LICENSE)
