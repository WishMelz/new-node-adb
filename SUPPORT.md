# 支持说明

这是一个面向单实例、本地或受信网络设备管理的开源项目，当前不提供 SLA 或商业支持。

## 提问前

请先阅读 README，并确认：

- Node.js、npm、ADB 和浏览器版本
- 使用 USB 还是网络 ADB
- `adb devices -l` 的状态（请移除设备序列号等敏感信息）
- 是否使用 Docker、反向代理或 HTTPS
- `npm run lint`、`npm test` 或 `npm run build` 的完整错误摘要

不要提交 `.env`、`.data`、bootstrap-password、Cookie、sessions.json 或包含设备凭据的日志。

## Issue 范围

适合提交：可重复的缺陷、文档错误、可验证的功能建议和部署问题。不适合提交：真实密码、私有设备信息、未经脱敏的网络日志或超出项目边界的商业支持请求。
