# 贡献指南

感谢参与 ADB Desk。提交代码前，请先确认改动范围、运行环境和安全影响。

## 开发环境

- Node.js 22.13 或更高版本
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

依赖检查使用官方源：`npm audit --registry=https://registry.npmjs.org`，可追加 `--omit=dev` 单独检查生产依赖。根配置通过 overrides 固定 Fastify、follow-redirects、glob 和 minimatch 的安全版本；ESLint 10 用于兼容新版 minimatch，因此最低 Node.js 提高到 22.13。更新锁文件建议使用精确版本 `npx --yes npm@11.21.1 install`，并核对 `npm ls` 和审计结果；宽泛的 `npx npm@11` 可能仍复用本机 11.5.1。旧锁条目未刷新时，用同一 npm 版本定向 `update`，不要降级框架或执行 `npm audit fix --force`。

Docker 验收脚本仅保留退出状态和白名单诊断，原始子进程异常可能包含密码、Cookie 或命令参数。该文件单独关闭 ESLint 的 `preserve-caught-error`，避免将原始异常通过 `cause` 带入日志。

真实设备相关改动还应说明使用的 Android 版本、ADB 状态和浏览器版本。没有硬件条件时，可以使用现有模拟测试，但不要把模拟结果表述为真机验收。

## Docker 验收

涉及 Docker、配置或静态托管的修改，完成前后端构建后执行：

```powershell
docker build -t adb-desk:local .
npm run test:docker -- adb-desk:local
```

测试使用临时容器和命名卷，Windows 上还检查临时宿主目录绑定挂载。覆盖非 root 默认数据目录权限、初始密码生成、容器重建后的会话和密钥恢复、自定义端口与数据目录、静态资源、健康检查、ADB 可执行文件和 sharp 原生依赖。在无网络/无 USB 的容器内启动项目 ADB server，对本地模拟设备的认证挑战验签，确认实际使用持久化密钥，并检查 server 崩溃后的并发恢复、关闭后拒绝调用，以及 HTTP 主进程持有 ADB 子进程时的容器正常退出。不会挂载现有数据目录或连接真实设备，结束后自动清理容器和测试卷，不输出私钥、密码或 Cookie。

后端密钥单元测试默认不需要系统 ADB。显式设置 `ADB_TEST_PATH` 后，`npm run test -w @adb/api` 会额外用该可执行文件的离线 `keygen/pubkey` 测试并发初始化、导入、身份冲突与公钥恢复；数据全部在临时目录中，不启动宿主机 server。Windows 示例：`$env:ADB_TEST_PATH = 'E:/platform-tools/adb.exe'`。测试完成后清除该变量。真实 Windows/macOS server、手机授权和 Android 11+ 配对仍需单独验收。

Linux 或已启用 host networking 的 Docker Desktop 可追加 `--host`，验证真实 Compose host 网络入口且不添加端口映射：

```powershell
npm run test:docker -- adb-desk:local --host
```

该选项要求 Docker daemon 位于当前宿主机，容器健康但宿主机无法访问时会明确失败，不自动修改系统网络设置。CI 在 Linux / Node.js 22 上执行镜像构建和此项验收。ARM64 镜像可用 `docker buildx build --platform linux/arm64 --load -t adb-desk:arm64 .` 构建，再指定镜像标签运行同一测试；异架构执行需要 Docker 仿真支持，不能替代真实 R2S 验收。

## Pull Request

Pull Request 应包含：

- 改动目的和主要实现位置
- 测试命令及结果
- 配置、部署或安全影响
- UI 改动的截图或复现步骤（如适用）
- 已知未验证项

请保持提交小而聚焦，不要在同一 Pull Request 中混入无关格式化或重命名。
