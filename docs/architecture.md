# 架构说明

## 总体结构

项目是 npm workspaces monorepo，包含 `apps/api` 和 `apps/web`。开发环境保留两个独立进程：Vite 监听 `23111` 并代理 `/api` 和 `/ws` 到监听 `23110` 的 API 服务。

生产环境只运行 NestJS/Fastify：同一端口托管 `apps/web/dist`、`/api` 和 `/ws`。Nginx 负责域名、TLS 和 WebSocket 反向代理，将所有路径原样转发到后端端口，不需要另建前端服务或由 Nginx 读取前端产物。配置和步骤见 [生产部署](../README.md#生产部署) 与 [Nginx 示例](../deploy/nginx/adb-console.conf)。

## API

- `config.ts`：读取并校验环境变量、会话和 scrcpy 路径。
- `auth.ts`：单管理员密码、Cookie 会话、会话持久化、登录失败限流和认证 Guard。
- `adb.ts`：参数化调用 ADB、解析设备、校验 serial、截图和设备状态。
- `devices.ts`：设备 HTTP API 与设备记录 JSON 持久化。
- `stream.ts`：scrcpy server 生命周期、TCP 转发、H.264 视频和控制通道。
- `main.ts`：Nest/Fastify 应用、Helmet、来源校验、静态资源和 WebSocket upgrade。

认证令牌只存在于 HttpOnly Cookie；`.data/sessions.json` 保存令牌摘要而不是明文令牌。管理员密码变化会使旧会话失效。WebSocket upgrade 必须同时通过 Origin、Cookie、会话和投屏归属校验。

## Web

`App.vue` 只负责恢复认证、显示登录页和异步加载 `WorkspaceView`。工作台由功能模块编排：

- `features/auth`：登录状态和登录页面。
- `features/devices`：设备列表、设备记录和工作台。
- `features/stream`：视频连接、JMuxer、触控和投屏生命周期。
- `components/layout`：顶部栏和操作日志抽屉。
- `components/device`：工具栏、画面、底栏、工具抽屉和设备记录抽屉。
- `composables`：操作日志和全屏、可见性、页面卸载等工作区行为。

组件负责展示和交互边界，业务状态和异步请求由 composable 或 feature 模块维护，避免页面入口聚集设备、投屏和弹框逻辑。

## 生命周期

登录后挂载工作台，初始化时停止旧投屏并刷新设备和记录。设备切换会停止当前投屏；工作台卸载、页面隐藏、失焦或会话过期时会取消触控并释放投屏资源。服务端注销先撤销会话，再停止该会话拥有的投屏。

## 部署边界

Docker 使用预构建模式：宿主机执行 `npm ci` 和 `npm run build`，镜像只安装 API 生产依赖并复制构建产物和 vendor。`.data` 通过卷挂载保存密码、会话和设备记录。该项目不负责管理宿主机 USB 权限，也不实现多用户租约或音频传输。
