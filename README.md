# dsh-quote-shot

面向 Windows DSH Desktop 的“划词引用 + 区域截图”插件：把聊天、代码块或文件预览中选中的文字连同来源插入输入框，也可以截取屏幕区域作为图片附件。所有内容都只进入输入框，**不会自动发送**。

## 功能

- **划词提问**：在聊天消息、代码块或文件预览中选中文字，右键选择“向DSH提问”，或按 `Ctrl+Alt+Q`。插件会把引用块插入当前输入框，并带上来源（文件路径与行号、对话轮次或代码语言）。
- **区域截图**：按 `Ctrl+Alt+Z`，或点击输入框旁的截图按钮，拖选屏幕区域。浮层提供两个操作：
  - **向DSH提问**：把 PNG 附到输入框；如果截图不在 DSH 窗口内、且没有可用的 DOM 来源，还会尝试本机 OCR，把识别出的候选来源以“自动识别：…”附上，供用户核对和修改。
  - **另存为**：只把截图保存为 PNG，不插入输入框；该操作没有快捷键。
- **不自动发送**：引用和截图附件都停留在输入框，发送动作始终由用户完成。

## 安装

前置条件：Windows 上的 DSH Desktop、可用的 `pnpm`，以及本机可访问的插件目录。

1. 安装到 DSH 的 `desktop` profile：

   ```powershell
   pnpm add --dir "C:\Users\Person\.dsh\profiles\desktop" "file:C:\Users\Person\Documents\deepseek-harness\default-workspace\dsh-quote-shot"
   ```

   如果插件目录不同，请把 `file:` 后的路径换成实际路径；profile 路径也按本机实际安装位置调整。

2. 编辑 `C:\Users\Person\.dsh\profiles\desktop\package.json`，把 `dsh-quote-shot` 加入 `dsh.profile.bundles`：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "dsh-quote-shot"
         ]
       }
     }
   }
   ```

   如果数组里已有其它插件，保留它们，只在末尾追加 `"dsh-quote-shot"`。

3. **完全退出并重新启动 DSH Desktop**。仅刷新页面或重载 Web 视图不会加载主进程插件。

4. 启动后可用 `Ctrl+Alt+Q` 或输入框旁的截图按钮验证。

## 卸载

1. 从 `C:\Users\Person\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 中删除 `"dsh-quote-shot"`。
2. 执行：

   ```powershell
   pnpm remove --dir "C:\Users\Person\.dsh\profiles\desktop" dsh-quote-shot
   ```

3. 完全重启 DSH Desktop。
4. 如需清理残留截图，可手动删除 `%TEMP%\dsh-quote-shot` 目录。

## 隐私与临时文件

- 截图临时文件放在 `%TEMP%\dsh-quote-shot`（通常是 `C:\Users\<用户名>\AppData\Local\Temp\dsh-quote-shot`）。
- 插件启动时会清理过期文件；临时 PNG 的 TTL 为 **1 小时**。
- 截图失败、取消或选择“另存为”后，临时 PNG 会被删除；选择“向DSH提问”成功后，文件由一次性 token 持有，客户端取图后通过 discard 删除。若页面在取图前关闭或丢弃请求失败，后台每 10 分钟检查一次，删除超过 1 小时 TTL 的文件，因此最多可能残留约 70 分钟。
- 不读取或写入剪贴板，不上传图片或文字。截图只通过本机 DSH 页面的插件 HTTP 端点传递，不经过外部服务。
- OCR 在本机通过 Windows WinRT OCR（PowerShell）完成，不上传识别内容。仅在截图区域与 DSH 窗口不相交且没有 DOM 来源时尝试；预算 **4 秒**，失败或超时静默跳过，不影响图片附件。

## 兼容性

- 目标平台是 **Windows DSH Desktop**（依赖 PowerShell 5.1 与 Windows WinRT）。
- Web 版只支持引用提问（右键菜单与 `Ctrl+Alt+Q`）；区域截图依赖桌面端，按钮会提示“截图仅桌面端可用”。
- 原生右键菜单无法由插件直接扩展，插件使用 DOM 菜单，并在识别到匹配选区时尽量抑制原生菜单。
- 高 DPI、多显示器和混合缩放场景按物理像素做坐标换算，首次使用前仍建议在本机实际验收。

## 已知限制

- OCR 依赖 Windows 已安装的 OCR 语言包；缺少语言包时不会产生候选，只附图片。识别结果可能受全角标点、空格或换行影响，来源会标为“自动识别”，请自行核对。
- v1 尚未实现 OCR 开关设置，OCR 常开；如不需要，忽略或删除自动识别的来源即可。
- 原生菜单抑制是 best-effort，不同 DSH/Electron 版本下系统菜单仍可能出现。
- “另存为”没有快捷键，这是有意设计。
- 截图浮层是插件自绘窗口，不是系统截图工具；多屏边界等行为请在发布前手工验收。

## 测试

```powershell
cd C:\Users\Person\Documents\deepseek-harness\default-workspace\dsh-quote-shot
node --test test/*.test.js
```

当前测试结果为 **92 个测试全部通过（92 pass / 0 fail）**。测试覆盖服务端 API、截图结果解析、OCR 候选提取、客户端引用和截图流程；真实桌面截图、OCR 语言包及多显示器行为仍需在 DSH Desktop 中手工验收。

## 打包内容

`npm pack` 只包含运行所需文件：`lib/`、`scripts/`、`cordis.patch.yml`、`README.md` 和 `package.json`。测试目录 `test/` 与 `.superpowers/` 不会进入安装包。

