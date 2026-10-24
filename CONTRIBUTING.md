# 贡献指南

感谢参与 ADB Control Room。提交代码前，请先确认改动范围、运行环境和安全影响。

## 开发环境

- Node.js 22.12 或更高版本
- npm
- Android Platform Tools（真机功能需要）
- 已授权的 Android 调试设备（设备功能验收需要）

安装并启动开发环境：

```powershell
npm ci
npm run dev
```

## 变更要求

- 保持 API、认证和设备边界清晰，优先复用现有模块和组合式逻辑。
- 不提交 `.env`、`.data`、日志、构建产物、令牌或设备信息。
- 不在日志、测试输出或错误响应中泄露密码、Cookie 或 bootstrap 凭据。
- 新增用户可见行为时补充对应的后端或前端测试。
- 涉及依赖升级时说明安全影响、兼容性和锁文件变化。

提交前运行：

```powershell
npm run check
```

依赖检查使用官方源：`npm audit --omit=dev --registry=https://registry.npmjs.org`。根配置用 override 将 Fastify 固定到已修复版本；npm 11.5.1 可能把该覆盖错误显示为 `invalid`，较新的 npm 11 已验证可正确识别。遇到此诊断时先更新 npm 再检查依赖树，不要降级 Fastify 或直接执行 `npm audit fix --force`。

真实设备相关改动还应说明使用的 Android 版本、ADB 状态和浏览器版本。没有硬件条件时，可以使用现有模拟测试，但不要把模拟结果表述为真机验收。

## Pull Request

Pull Request 应包含：

- 改动目的和主要实现位置
- 测试命令及结果
- 配置、部署或安全影响
- UI 改动的截图或复现步骤（如适用）
- 已知未验证项

请保持提交小而聚焦，不要在同一 Pull Request 中混入无关格式化或重命名。
