# dsh-quote-shot

面向 **Windows DSH Desktop** 的交互增强插件：划词引用、区域截图，并把截图作为工作区文件引用附加到输入框。

## 功能

- **划词引用**：在聊天记录或右侧文件预览中选中文字/代码，右键选择“向DSH提问”，引用会插入当前输入框顶部。
- **蓝色引用**：引用内容以蓝色文本块显示，与用户自己输入的问题区隔；用户输入保持当前主题的默认文字颜色，引用末尾保留 `【引用结束】`。
- **长引用折叠**：超过 8 行或 640 字的引用默认折叠，显示“展开引用”按钮；展开后可继续编辑，发送时仍是完整原文。
- **区域截图**：按 `Ctrl+Alt+Z`，拖拽选择屏幕区域；完成后选择“向DSH提问”或“另存为”。
- **文件引用**：截图保存在当前会话工作区的 `quote-shot-captures/` 目录，并以 DSH 文件引用插入输入框，同时附上可编辑的截图来源说明。
- **不自动发送**：引用和截图都只填入输入框，由用户确认后发送。

## 要求

- Windows 10/11。
- DSH Desktop（Web 版只能使用划词引用，不能截图）。
- Node.js >= 22，pnpm。
- Windows PowerShell 5.1（系统自带）。
- 截图功能需要可用的桌面会话；锁屏或远程会话断开时可能失败。

## 安装

### 从 Release 安装

当前公开 Release 为 `v0.1.1`。新版本发布后可替换 `$releaseVersion`。

```powershell
$dshProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$releaseVersion = 'v0.1.1'
$releaseUrl = "https://github.com/PolarVag/dsh-quote-shot/releases/download/$releaseVersion/dsh-quote-shot.tgz"
pnpm add --dir $dshProfile $releaseUrl
```

> pnpm 不能解析 GitHub 的 `releases/latest/download` 跳转，必须使用带版本号的下载地址。

### 从源码安装

```powershell
git clone https://github.com/PolarVag/dsh-quote-shot.git C:\tools\dsh-quote-shot
$dshProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
pnpm add --dir $dshProfile "file:C:/tools/dsh-quote-shot"
```

## 启用插件

打开 `C:\Users\<你>\.dsh\profiles\desktop\package.json`，在 `dsh.profile.bundles` 中加入：

```json
"dsh-quote-shot"
```

然后**完全退出并重新启动 DSH Desktop**，仅刷新页面不够。

## 使用

1. 在聊天记录或文件预览中选中一段内容。
2. 右键，点击“向DSH提问”，或按 `Ctrl+Alt+Q`。
3. 引用会插入输入框；长引用显示为折叠的蓝色块，可点“展开引用”。
4. 在引用后面继续输入问题，确认后发送。
5. 按 `Ctrl+Alt+Z` 截图，拖拽区域后选择“向DSH提问”或“另存为”。

## 快捷键

| 功能 | 默认快捷键 |
| --- | --- |
| 引用选中内容 | `Ctrl+Alt+Q` |
| 区域截图 | `Ctrl+Alt+Z` |

快捷键只在 DSH 窗口处于前台时生效，可在 DSH 的快捷键设置中重新绑定。截图完成后的“另存为”没有快捷键。

## 截图与隐私

- 截图临时文件位于 `%TEMP%\dsh-quote-shot`，默认 1 小时过期。
- 选择“向DSH提问”后，PNG 会复制到当前会话工作区的 `quote-shot-captures/`，作为普通工作区文件使用。
- 插件不上传截图，不读取剪贴板，不自动发送消息。
- 截图来源通过界面上的文件预览或聊天轮次推断；推断不到时只附加图片，不写来源。
- OCR 仅在截图区域完全位于 DSH 窗口之外时尝试，用于从画面文字中猜测文件路径；识别结果只是可编辑的参考。

## 兼容性

- DSH Desktop 0.2.1 及以上。
- 桌面端支持划词引用和截图；Web 端只支持划词引用与 `Ctrl+Alt+Q`。
- 右键菜单是插件自绘菜单。DSH 的 Electron 原生菜单没有插件扩展点，部分版本可能同时出现系统菜单；插件功能不受影响。

## 已知限制

- 多显示器且缩放比例不同时，截图区域可能按主显示器缩放计算。
- 安全窗口、受保护视频等系统限制区域可能显示为黑块。
- 长引用折叠使用编辑器的文本样式实现；展开后若切换会话，未发送内容以 DSH 的草稿机制为准。
- OCR 是尽力而为，不保证识别出路径。

## 故障排查

**右键没有“向DSH提问”**

- 确认插件在 `dsh.profile.bundles` 中，并已完全重启 DSH。
- 确认选中的是聊天内容或文件预览中的文字，而不是输入框或侧栏标题。

**提示“截图附加失败（读取图片）”**

- 通常是插件版本过旧或图片路由未加载；更新并完全重启 DSH。
- 检查 `%TEMP%\dsh-quote-shot` 是否可写。

**提示“截图附加失败（插入文件引用）”**

- 检查当前会话工作目录是否可写。
- 检查截图期间是否切换了会话；插件会固定使用开始截图时的会话。

**快捷键没有反应**

- 检查 DSH 快捷键设置中是否冲突或被禁用。
- 确认 DSH 窗口在前台；快捷键不是系统级全局热键。

## 开发

```powershell
cd $pluginPath
node --test test/*.test.js
```

当前测试：**113 个测试全部通过（113 pass / 0 fail）**。

目录结构：

```text
lib/
  index.js        Host 半：Web 路由、截图存储、工作区复制、OCR
  client.js       Client 半：划词引用、蓝色折叠、快捷键、截图 UI
  capture.js      截图结果解析、临时文件与 token 管理
scripts/
  capture.ps1     WinForms 区域截图浮层
  ocr.ps1         Windows WinRT OCR
test/             单元测试
cordis.patch.yml  DSH 插件注册
```

打包检查：

```powershell
npm pack --dry-run --json
```

`npm pack` 只包含运行所需文件，不包含 `test/` 与 `.superpowers/`。

## License

MIT
