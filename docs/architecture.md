# 架构说明

## 总体结构

项目是 npm workspaces monorepo，包含 `apps/api` 和 `apps/web`。根目录 `.env` 使用 `ADMIN_PASSWORD`、`DATA_DIR`、`DEV_WEB_PORT`、`DEV_API_PORT`、`DOCKER_PORT` 五项配置，监听地址固定为 `0.0.0.0`。开发环境保留两个进程，Vite 使用 `DEV_WEB_PORT`（默认 `23111`），自动代理 `/api` 和 `/ws` 到 `127.0.0.1:DEV_API_PORT`（默认 `23110`）。两个开发端口必须不同；静态构建不读取开发端口，密码和数据目录不注入前端。

`NODE_ENV=production` 时，后端只读取 `DOCKER_PORT`（默认 `23120`），在一个端口托管 `apps/web/dist`、`/api` 和 `/ws`，其他模式读取 `DEV_API_PORT`。Docker 自动设置 production 模式，直接运行 Node，不安装 Nginx，也没有双进程启动器。Compose 使用 host 网络，没有 `ports` 映射；Linux 可直接使用，Docker Desktop 需要支持并启用 host networking。公网域名/TLS 可由外部 Nginx 处理，FRP 指向宿主机 `DOCKER_PORT`，防火墙应限制可访问范围。ADB 使用项目独立的动态回环端口，不连接宿主机 5037。配置和步骤见 [生产部署](../README.md#生产部署) 与 [Nginx 示例](../deploy/nginx/adb-console.conf)。

`DATA_DIR` 留空为根目录 `.data`，本地相对路径按工程根解析，支持绝对路径；初始密码、会话、设备和两步验证共用该目录。Compose 将宿主机 `DATA_DIR` 挂载到容器 `/app/.data`，并将内部 `DATA_DIR` 和 `HOME` 固定为该路径，容器 ADB 密钥随之持久化。变更路径不自动搬迁数据，须停服迁移并保留权限。

## API

- `config.ts`：读取并校验环境变量、会话和 scrcpy 路径。
- `auth.ts`：单管理员密码、Cookie 会话、会话持久化、登录失败限流和认证 Guard。
- `adb.ts`：延迟启动自有前台 ADB server、固定子进程身份环境、参数化调用、设备解析和截图；在投屏销毁后的 shutdown 阶段关闭自有进程。
- `adb-identity.ts`：所有平台统一使用 `DATA_DIR/.android`，通过官方 ADB 离线命令生成/派生公钥，原子发布、校验及幂等导入，不覆盖已有身份。CLI 提供 `init`、只读 `status` 和显式路径 `import`，不经 HTTP 暴露私钥。
- `devices.ts`：设备 HTTP API 与设备记录 JSON 持久化。
- `stream.ts`：scrcpy server 生命周期、TCP 转发、H.264 视频和控制通道。
- `main.ts`：Nest/Fastify 应用、Helmet、静态资源和 WebSocket upgrade。

认证令牌只存在于 HttpOnly Cookie；`.data/sessions.json` 保存令牌摘要而不是明文令牌。管理员密码变化会使旧会话失效。WebSocket upgrade 必须通过 Cookie、会话和投屏归属校验，不按 Origin 限制。

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

Docker 使用预构建模式：宿主机执行 `npm ci` 和 `npm run build`，镜像只安装 API 生产依赖并复制构建产物和 vendor。`DATA_DIR` 通过卷挂载保存密码、会话和设备记录。该项目不负责管理宿主机 USB 权限，也不实现多用户租约或音频传输。
