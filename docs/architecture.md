# 架构说明

## 总体结构

项目是 npm workspaces monorepo，包含 `apps/api` 和 `apps/web`。根目录 `.env` 使用 `ADMIN_PASSWORD`、`DATA_DIR`、`DEV_WEB_PORT`、`DEV_API_PORT`、`DOCKER_PORT` 五项配置，监听地址固定为 `0.0.0.0`。开发环境保留两个进程，Vite 使用 `DEV_WEB_PORT`（默认 `23111`），自动代理 `/api` 和 `/ws` 到 `127.0.0.1:DEV_API_PORT`（默认 `23110`）。两个开发端口必须不同；静态构建不读取开发端口，密码和数据目录不注入前端。

`NODE_ENV=production` 时，后端只读取 `DOCKER_PORT`（默认 `23120`），在一个端口托管 `apps/web/dist`、`/api` 和 `/ws`，其他模式读取 `DEV_API_PORT`。Docker 自动设置 production 模式，直接运行 Node，不安装 Nginx，也没有双进程启动器。Compose 使用 host 网络，没有 `ports` 映射；Linux 可直接使用，Docker Desktop 需要支持并启用 host networking。公网域名/TLS 可由外部 Nginx 处理，FRP 指向宿主机 `DOCKER_PORT`，防火墙应限制可访问范围。ADB 使用项目独立的动态回环端口，不连接宿主机 5037。配置和步骤见 [生产部署](../README.md#生产部署) 与 [Nginx 示例](../deploy/nginx/adb-console.conf)。

`DATA_DIR` 留空为根目录 `.data`，本地相对路径按工程根解析，支持绝对路径；管理员账户、会话、设备和两步验证共用该目录。`ADMIN_PASSWORD` 留空时由数据库决定是否进入首次注册，第一位注册者是唯一管理员；已有旧版 `bootstrap-password` 仅兼容读取。Compose 将宿主机 `DATA_DIR` 挂载到容器 `/app/.data`，并将内部 `DATA_DIR` 和 `HOME` 固定为该路径，容器 ADB 密钥随之持久化。变更路径不自动搬迁数据，须停服迁移并保留权限。

## API

- `config.ts`：读取并校验环境变量、会话和 scrcpy 路径。
- `auth.ts`：首次注册唯一管理员、环境密码兼容、Cookie 会话、会话持久化、登录失败限流和认证 Guard。
- `storage.ts`：Node 内置 SQLite、同步事务、版本化 schema 及旧 JSON 的一次性事务迁移。
- `two-factor.ts`：TOTP、恢复码和可信浏览器验证，持久化状态由共享的存储服务管理。
- `adb.ts`：延迟启动自有前台 ADB server、固定子进程身份环境、参数化调用、设备解析和截图；在投屏销毁后的 shutdown 阶段关闭自有进程。
- `adb-identity.ts`：所有平台统一使用 `DATA_DIR/.android`，通过官方 ADB 离线命令生成/派生公钥，原子发布、校验及幂等导入，不覆盖已有身份。CLI 提供 `init`、只读 `status` 和显式路径 `import`，不经 HTTP 暴露私钥。
- `devices.ts`：设备 HTTP API 与设备记录的 SQLite 查询和更新。
- `stream.ts`：scrcpy server 生命周期、TCP 转发、H.264 视频和控制通道。
- `main.ts`：Nest/Fastify 应用、Helmet、静态资源和 WebSocket upgrade。

认证令牌只存在于 HttpOnly Cookie；`DATA_DIR/adb-desk.sqlite` 的 `admin_account` 表保存唯一管理员的密码盐、哈希和创建时间，`sessions` 表保存令牌摘要而不是明文令牌，`devices` 表保存设备记录，`two_factor` 表保存单管理员 2FA 状态。首次注册在 `BEGIN IMMEDIATE` 事务中使用 singleton 主键，竞态下只有一个请求成功；注册后不提供第二用户入口。管理员密码变化会使旧会话失效。WebSocket upgrade 必须通过 Cookie、会话和投屏归属校验，不按 Origin 限制。

业务持久化状态不在内存中保留第二份副本。共享 `StorageService` 使用短连接、`BEGIN IMMEDIATE` 和 `synchronous=FULL`，同一同步调用链内的事务共用连接，提交失败则回滚；事务回调不得异步。2FA 消费、可信浏览器签发和会话替换作为一个事务提交。数据库使用默认 rollback journal，不启用 WAL。`PRAGMA user_version` 标记 schema 版本，首次建表及旧 JSON 导入在同一事务完成，导入成功后保留旧文件但不再读写。升级、备份和回退限制见 [SQLite 存储与升级](../README.md#sqlite-存储与升级)。

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

登录后挂载工作台，初始化时停止旧投屏并刷新设备和记录。设备切换会停止当前投屏；工作台卸载、页面隐藏、失焦或会话过期时会取消触控并释放投屏资源。服务端注销尝试撤销会话，无论数据库撤销是否成功都会清理投屏；撤销失败返回错误，保留 Cookie 和一致的数据库状态以便重试，成功后才清除 Cookie。

## 部署边界

Docker 使用预构建模式：宿主机执行 `npm ci` 和 `npm run build`，镜像只安装 API 生产依赖并复制构建产物和 vendor。`DATA_DIR` 通过卷挂载保存数据库和 ADB 身份；新部署的管理员密码只保存为数据库哈希，旧版 `bootstrap-password` 仅兼容读取。SQLite 不改变单实例边界：登录挑战、限流、设备在线状态和投屏仍在进程内，不能多实例共享数据目录。该项目不负责管理宿主机 USB 权限，也不实现多用户租约或音频传输。
