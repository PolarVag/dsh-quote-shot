# dsh-quote-shot

一个面向 **Windows DSH Desktop** 的交互增强插件：选中聊天、代码块或文件预览中的文字后，可以带来源引用到输入框；也可以截取屏幕区域，把截图保存到当前会话工作目录并以文件引用插入输入框。

所有内容都只进入输入框，**不会自动发送**。

## 功能

### 划词引用

- 在聊天消息、代码块或文件预览中选中文字，按 `Ctrl+Alt+Q`，或右键选择 **向DSH提问**。
- 引用块会自动带上来源：
  - 文件预览：`@相对路径（第 N–M 行）`，在 DSH 中显示为蓝色文件引用；
  - 聊天消息：`对话第 N 轮`；
  - 代码块：额外标注代码语言。
- 每段引用末尾插入 `【引用结束】`，与用户随后输入的问题明确分开。
- 打开右键菜单时，选中的文字仍以半透明蓝色高亮保留。

### 区域截图

- 按 `Ctrl+Alt+Z`，或点击输入框旁的截图按钮。
- 拖选屏幕区域后，浮层提供两个操作：

| 操作 | 行为 |
| --- | --- |
| **向DSH提问** | 把截图保存到当前会话工作目录的 `quote-shot-captures/`，以 `@quote-shot-captures/xxx.png` 文件引用插入输入框，并附 `【截图来源】` 说明。 |
| **另存为** | 只把截图另存为 PNG，不插入输入框；该操作没有快捷键。 |

- `Esc`、右键或点击浮层外部可取消截图。
- 如果截图来自 DSH 窗口外，插件会尝试用本机 Windows OCR 识别截图中的路径，并以“自动识别：…”提示候选来源。识别失败时只插入截图文件引用，不阻塞主流程。

## 环境要求

- Windows 10 / 11。
- **DSH Desktop**（Windows 桌面版）。插件在 DSH Desktop `0.2.1-rc.2` 上开发和验证，DSH 客户端接口仍可能随版本变化。
- `pnpm`（用于安装到 DSH profile）。
- Windows PowerShell 5.1（系统自带）；OCR 需要系统安装对应语言的 OCR 语言包。
- Web 版 DSH 只能使用划词引用，不能使用区域截图。

## 安装

以下命令以 PowerShell 为例。请把插件目录替换成你实际克隆/解压的位置。

### 1. 获取源码

```powershell
$pluginPath = Join-Path $env:USERPROFILE 'dsh-quote-shot'
git clone https://github.com/PolarVag/dsh-quote-shot.git $pluginPath
```

也可以下载 ZIP 后解压到任意目录。

### 2. 安装到 DSH 的 desktop profile

```powershell
$dshProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$pluginUrl = 'file:' + ($pluginPath -replace '\\', '/')
pnpm add --dir $dshProfile $pluginUrl
```

`file:` 后面必须是插件目录的绝对路径，使用正斜杠或双反斜杠。

### 3. 启用插件 bundle

打开：

```text
C:\Users\<用户名>\.dsh\profiles\desktop\package.json
```

在 `dsh.profile.bundles` 数组中加入 `"dsh-quote-shot"`，保留已有插件：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-vision-plugin",
        "dsh-quote-shot"
      ]
    }
  }
}
```

### 4. 完全重启 DSH Desktop

仅刷新页面不够，需要**完全退出 DSH Desktop 后重新启动**，让主进程和客户端 bundle 一起重新加载。

## 使用

### 引用文字

1. 在聊天、代码块或文件预览中选中文字。
2. 按 `Ctrl+Alt+Q`，或右键选择 **向DSH提问**。
3. 引用会插入当前输入框，末尾带 `【引用结束】`。
4. 在引用后继续输入问题，确认后手动发送。

### 截图

1. 按 `Ctrl+Alt+Z`，或点击输入框旁的截图按钮。
2. 拖选区域。
3. 选择 **向DSH提问** 或 **另存为**。

截图文件默认保存到当前会话工作目录：

```text
<session workspace>/quote-shot-captures/shot-YYYYMMDD-HHmmss.png
```

如果工作目录不可写，或者当前会话没有解析出 `cwd`，会退回临时图片附件方式。

### 修改快捷键

快捷键通过 DSH 的快捷键设置注册，默认值为：

- 划词引用：`Ctrl+Alt+Q`
- 区域截图：`Ctrl+Alt+Z`

如果与其它命令冲突，DSH 会拒绝注册或提示冲突；请在 DSH 的快捷键设置中改绑。**另存为**有意不提供快捷键。

## 隐私与临时文件

- 截图临时文件位于 `%TEMP%\dsh-quote-shot`，临时 PNG 的 TTL 为 **1 小时**。
- 选择 **向DSH提问** 后，PNG 会复制到会话工作目录的 `quote-shot-captures/`；这是对话/报告内容的一部分，卸载插件不会自动删除。
- 取消截图或另存为后，临时 PNG 会被删除。
- 插件不读写剪贴板，不上传图片或文字，也不调用外部视觉服务。
- OCR 在本机通过 Windows WinRT OCR（PowerShell）完成；仅在截图区域与 DSH 窗口不相交且没有 DOM 来源时尝试，预算 **4 秒**，失败或超时静默跳过。

## 兼容性与已知限制

- 截图依赖 DSH Desktop 的本地 Web 服务与 PowerShell，Web 版不可用。
- 原生右键菜单无法由插件直接扩展；插件使用 DOM 菜单，并在识别到匹配选区时尽量抑制原生菜单。不同 DSH/Electron 版本下系统菜单仍可能出现。
- 文件引用和选区高亮依赖 DSH 客户端的 DOM 结构；DSH 升级后可能需要适配。
- 高 DPI、多显示器和混合缩放场景按物理像素换算；首次使用前建议在本机实际验收。
- v1 尚未实现 OCR 开关设置，OCR 常开。
- 截图文件夹由用户自行清理；插件不会自动删除工作目录中的历史截图。

## 故障排查

**截图按钮提示“截图仅桌面端可用”**

- 确认是 Windows DSH Desktop，而不是浏览器 Web 版。
- 确认已完全重启 DSH，且 `dsh.profile.bundles` 中含 `dsh-quote-shot`。
- 检查 profile 的 `node_modules\dsh-quote-shot` 是否存在。

**提示“截图附加失败（读取图片）”**

- 通常是插件版本过旧或图片路由未加载。更新到最新版本并完全重启 DSH。

**提示“截图附加失败（插入文件引用）”**

- 检查当前会话工作目录是否可写。
- 检查是否在截图期间切换了会话；插件会把截图固定在开始截图时的会话，不会写入另一个会话。

**右键后仍出现系统菜单**

- 这是 Electron 原生菜单的 best-effort 抑制，无法保证在所有版本都消失；插件自己的“向DSH提问”菜单仍可使用。

**快捷键没有反应**

- 在 DSH 快捷键设置中检查是否冲突或被禁用。
- 确认 DSH 窗口处于前台；快捷键不是系统级全局热键。

## 开发

```powershell
cd $pluginPath
node --test test/*.test.js
```

当前测试：**101 个测试全部通过（101 pass / 0 fail）**。

目录结构：

```text
lib/
  index.js        Host 半：Web 路由、截图存储、工作目录复制、OCR
  client.js       Client 半：右键引用、选区高亮、快捷键、截图 UI
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
