# DJH 🛠️

一套 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的社区插件合集与部署增强包。
DSH 本身是「毛坯房」，DJH 提供一批开箱即用的本地插件，把对话界面、手机体验、语音播报、模型中心这些都装修好。

> 本仓库 **不含任何密钥/个人数据**。所有需要凭据的地方都提供 `*.example` 模板，自行填写。

## 插件一览（27 个）

### 🌟 通用推荐（装了就爽）
| 插件 | 作用 |
| --- | --- |
| `dsh-quote-menu` | 划词右键：问 AI / 引用 / 复制（含旁问小窗） |
| `dsh-swipe-sidebar` | 手机窄屏左缘右滑开侧栏，返回键联动 |
| `dsh-scroll-hide-chrome` | 手机滚动时顶栏浮层滑出、输入框收起，向上滑秒回 |
| `dsh-row-fork` | 左栏会话行一键「分叉」出子会话 |
| `dsh-session-ctx-pill` | 左栏实时显示会话上下文占用百分比 |
| `dsh-sfx` | 界面音效 |
| `dsh-agent-progress` | 子代理运行进度提示 |
| `dsh-screenshot` | 截图贴会话 |
| `dsh-plugin-hub` | 本地插件管理面板 |
| `dsh-preset-switch` | 预设一键切换 |

### 📦 也可单独从 npm 安装

以下插件已发布到 npm，可独立安装后按 DSH 插件挂载方式启用：

```bash
npm i dsh-quote-menu dsh-swipe-sidebar dsh-scroll-hide-chrome dsh-row-fork dsh-sfx dsh-session-ctx-pill dsh-agent-progress
```

### 🏠 增强类（按需装，部分需配 API key）
| 插件 | 作用 |
| --- | --- |
| `dsh-model-hub` | 模型中心：比价、别名、免费标签（顶掉原生模型页） |
| `dsh-tts-voice` | 四家 TTS（DeepSeek/火山/阿里/Breeze）来源与音色管理 |
| `dsh-status-pills` | 右上角内存/余额/积分胶囊（需自行配 token） |
| `dsh-ai-news` | 左栏 AI 新闻面板 + 追问开新会话 |
| `dsh-owner-profile` | 主人画像管理（个人向） |
| `dsh-lesson-recall` | 教训库按关键词自动注入提示词 |
| `dsh-msg-speak` / `dsh-orb-bridge` | 消息播报 / 桌面宠物桥接 |
| `dsh-attach-tiles` | 附件待办条与任务面板优化 |
| `dsh-autoresume` | 重启后续跑被打断的会话 |
| `dsh-rest-mode` | 休息模式胶囊 + 提示词注入 |
| `dsh-hide-mode-chip` | 隐藏界面噪音元素 |
| `dsh-version-badge` | 左下角显示版本号角标 |
| `dsh-butler-mode` / `dsh-butler-rotate` | 大管家模式增强 |
| `dsh-shot-settings` / `dsh-video-eyes` | 截图设置 / 视频感知实验 |

## 安装

前置：先装好官方 DSH（`npm i -g @deepseek-ai/dsh`），至少完整启动过一次。

```powershell
git clone <本仓库> E:\DJH-open
powershell -ExecutionPolicy Bypass -File E:\DJH-open\install.ps1
```

脚本会：把 27 个插件复制到你工作区的 `plugins\` 目录 → 建 `@local` junction → 写入 profile 的 `package.json` link 依赖（自动备份原文件）。重启 DSH 后生效。

详细说明（含官方包补丁、自动化任务建议）见 [docs/安装指南.md](docs/安装指南.md)。

## 致谢

- 感谢 DeepSeek 的 [DeepSeek Harness](https://github.com/deepseek-ai) —— 本项目全部插件基于其插件体系构建
- 部分思路参考社区项目，见 [CREDITS.md](CREDITS.md)

## License

[MIT](LICENSE)
