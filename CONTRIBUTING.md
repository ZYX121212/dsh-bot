# Contributing

欢迎提交 Bug、产品建议和 Pull Request。

## 本地开发

需要 Node.js >=24.9.0，以及与本项目声明兼容的 DSH 版本。

```bash
npm ci --ignore-scripts
npm run check
npx playwright install chromium
npm run test:browser
```

macOS 浏览器测试默认使用已安装的 Google Chrome；其他系统使用 Playwright Chromium。可通过 `CHROME_PATH` 显式指定浏览器。安装 SDK 后，host 接口测试使用真实的 npm SDK peers；`DSH_SDK_ROOT` 可指向现有 DSH 安装的 `node_modules/@deepseek-ai` 目录。

浏览器验收中的会话、模型文本、工具与授权事件是明确的测试替身，不应把通过结果描述为真实模型端到端测试。更改会话、权限或工具行为时，请额外在已认证 DSH 界面做低风险联调，并说明环境。

## 提交要求

- 保持 Bot 身份、会话关联、记忆注入与真实执行一致，不增加虚假的工作进度或连接器。
- 不抓取凭据，不伪造 owner peer，不自动批准原生授权。
- 不提交 API Key、Cookie、个人配置、聊天日志或本机工作产物。
- 对持久化、并发、恢复、取消等行为补充回归测试。
- 将公开预览图放在 [截图目录](docs/screenshots/README.md)，不要提交整个运行时 artifacts 目录。
- 标明功能边界和验证范围。云电脑与关机后运行需要真实基础设施，不能靠 UI 宣称实现。

## Issue / PR

Bug 报告请包含 DSH / Node / 操作系统版本、复现步骤和脱敏错误。请勿公开粘贴令牌、完整聊天记录或私有工具结果。提交代码前运行 `npm run check`；涉及界面的改动也请运行 `npm run test:browser`。

本项目采用 [MIT License](LICENSE)。提交贡献即表示同意贡献按该许可证分发。
