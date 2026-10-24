# ADB Control Room

独立重构版本，不依赖旧项目运行。后端使用 NestJS 11 + Fastify 5 + TypeScript，前端使用 Vue 3 + TDesign Vue Next + Vite。

## 技术选择

- NestJS 管理认证、设备与远程控制模块的依赖和生命周期；Fastify 负责 HTTP、Cookie 和静态资源。
- ADB 通过参数化子进程调用，所有设备操作显式传入 serial，并进行 DTO 和设备就绪校验。
- scrcpy 4.0 输出 H.264，经 WebSocket 传输，由 JMuxer 转封装为浏览器 MediaSource 可播放的 MP4。
- 单管理员密码 + 本地持久化会话适用于单实例、本地/受信网络设备管理，不引入数据库；不等同于多租户权限系统。

## 运行

需要 Node.js 22.12+、npm、Android Platform Tools，以及开启并授权 USB 调试的 Android 设备。先在终端执行 `adb devices -l` 确认设备状态为 `device`。

在本目录运行：

```powershell
npm ci
npm run dev
```

- 开发界面：`http://127.0.0.1:23111`
- API：`http://127.0.0.1:23110/api/health`
- Vite 代理 `/api` 和 `/ws`。修改 API 端口时，也要修改 `apps/web/vite.config.ts` 中的代理目标。
- 未配置 `ADMIN_PASSWORD` 时，服务首次启动生成随机密码，保存在 `.data/bootstrap-password`。请在本机查看，不要提交或分享该文件。
- `.data`、`.env`、构建产物和依赖目录均已忽略。Windows 下请使用当前用户的文件权限保护 `.data`，POSIX 文件权限参数不等同于 Windows ACL。

开发环境保留两个独立项目和进程，`npm run dev` 只负责同时启动它们；也可在两个终端分别运行 `npm run dev -w @adb/api` 和 `npm run dev -w @adb/web`，前端使用 Vite 热更新，不依赖前端构建产物。

### 生产部署

```powershell
npm run build
npm start
```

`npm run build` 编译前后端；`npm start` 只启动 NestJS，不运行 Vite。NestJS/Fastify 从 `apps/web/dist` 提供首页和静态资源，同一端口提供 `/api` 和 `/ws`。直接访问 `http://127.0.0.1:23110` 可验证托管结果。每次更新前端都应重新构建并重启后端，部署时必须包含 `apps/api/dist`、`apps/web/dist`、`vendor` 及 API 生产依赖，保留 `.data`。

### Nginx 域名入口

生产部署拓扑如下，Nginx 不单独托管前端目录，也不转发到 Vite：

```text
浏览器 https://adb.example.com
	-> Nginx :443（TLS 终止、HTTP/WebSocket 反向代理）
	-> NestJS 127.0.0.1:23110
			 /、/assets/*  -> apps/web/dist
			 /api/*       -> 后端 API
			 /ws/*        -> 投屏 WebSocket
```

在生产服务器根目录 `.env` 配置实际域名；开发环境保持原有 HTTP 配置：

```dotenv
HOST=127.0.0.1
PORT=23110
PUBLIC_ORIGIN=https://adb.example.com
COOKIE_SECURE=true
```

使用 [Nginx 示例配置](deploy/nginx/adb-console.conf)，替换其中的域名和 TLS 证书路径，将其放入服务器由 Nginx `http` 块包含的配置目录（通常为 `/etc/nginx/conf.d/`）。文件包含 `map` 和完整 `server` 块，不能直接嵌入已有的 `server` 块。证书须提前签发并部署；示例不包含证书申请流程。在服务器完成配置后执行 `nginx -t`，确认通过再重载 Nginx。

所有路径原样代理到后端端口，前端继续使用同源 `/api` 和 `/ws`，无需写死域名或开放 CORS。WebSocket 升级头和长连接超时已配置；不要移除升级头，也不要覆盖浏览器的 `Origin`。`PUBLIC_ORIGIN` 和 `COOKIE_SECURE` 用于 HTTPS 来源校验和安全 Cookie，TLS 在 Nginx 终止后，上游仍使用本机 HTTP。

示例假设 Nginx 与后端位于同一台服务器；使用下方 Docker Compose 时，宿主机 Nginx 同样代理到映射的 `127.0.0.1:23110`。若 Nginx 也在容器内，需使用共享容器网络和服务名作为上游，不能使用其自身的 `127.0.0.1`。后端端口不应直接暴露到公网，只开放 Nginx 入口，并配合 VPN 或网络访问限制。当前后端未开启对代理 IP 头的信任，限流按上游代理来源聚合，不会仅凭客户端传入的转发头识别 IP。

上线验收：访问域名首页和 `/api/health`；确认登录 Cookie 带 `Secure`；启动投屏时确认 `/ws/streams/...` 返回 `101 Switching Protocols`。当前前端没有 history 路由，不配置未知路径回退，缺失的 API 和静态资源仍返回 404。

### Docker 部署

先执行 `npm ci` 和 `npm run build`，将源码、构建产物、锁文件、`vendor`、`Dockerfile` 和 `compose.yaml` 一起迁移；不要复制本机 `node_modules`。镜像安装目标架构的生产依赖及 ADB，支持 ARM64。现有 `.data` 可随项目迁移以保留访问密码、登录会话和设备记录，不要将其打入镜像或公开分享。

在 Linux 部署目录执行：

```sh
mkdir -p .data
chown -R 1000:1000 .data
chmod 700 .data
docker compose build
docker compose up -d --wait
```

默认只发布 `127.0.0.1:23110`；受信局域网部署可在服务器 `.env` 中设置 `BIND_IP=192.168.3.11` 等实际网卡地址。此配置采用 HTTP，不应新增公网转发；公网访问需另行配置 HTTPS/VPN。容器以非 root 用户运行，设置自动重启、健康检查、日志轮转和 256 MiB 内存上限。用 `docker compose logs --tail 100` 查看日志，`docker compose restart` 重启，`docker compose down` 停止但保留 `.data`。

容器内 ADB 与宿主机 ADB 隔离，当前部署针对网络设备连接，不接管现有 ADB 服务、USB 设备或已有连接。首次连接手机可能需重新授权；ADB 密钥保存在 `.data/.android`，容器重建后保留。需要 USB 时应单独配置设备访问权限，不能仅靠本配置发现宿主机 USB。

## 配置

按需以 `.env.example` 为基础创建根目录 `.env`，或设置同名环境变量：

| 变量                   | 默认值 / 作用                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `HOST`                 | `127.0.0.1`；仅本机监听                                                                                    |
| `PORT`                 | `23110`                                                                                                    |
| `ADMIN_PASSWORD`       | 留空时生成本机密码；自定义时至少 12 个字符                                                                 |
| `SESSION_HOURS`        | `24`；从登录时起计算的有效小时数，须为不小于 24 的整数，例如 `168` 表示 7 天；修改后重启服务，对新登录生效 |
| `LOGIN_MAX_ATTEMPTS`   | `5`；同一来源 IP 在限流窗口内允许的失败次数                                                                |
| `LOGIN_WINDOW_MINUTES` | `15`；登录失败计数窗口，范围为 1-1440 分钟                                                                 |
| `ADB_PATH`             | `adb`；也可填 adb.exe 绝对路径                                                                             |
| `SCRCPY_SERVER_PATH`   | `vendor/scrcpy-server-v4.0` 的绝对路径                                                                     |
| `SCRCPY_VERSION`       | `4.0`；必须与二进制版本匹配                                                                                |
| `PUBLIC_ORIGIN`        | 留空采用请求 Host 同源检查；反向代理部署填完整页面源，如 `https://adb.example.com`，不带末尾斜杠           |
| `COOKIE_SECURE`        | `false`；HTTPS 部署设为 `true`                                                                             |

登录 Cookie 与服务端会话有效期一致，默认登录后 24 小时内无需重复登录，不按午夜清零。刷新页面、关闭后重新打开浏览器或重启服务不会使未到期会话失效；主动退出、清除 Cookie 或更换访问密码后需重新登录。会话以令牌摘要而非明文令牌保存在 `.data/sessions.json`，部署时需保留并保护 `.data`。从旧版内存会话升级后需重新登录一次。

反向代理必须转发 WebSocket upgrade。不要直接将 ADB 或此控制台暴露到公网；远程访问应通过 HTTPS、VPN 或受控网络。开发服务器默认仅绑定本机。

## 功能与边界

- Cookie 登录、退出、默认 24 小时可配置持久化会话、登录失败限流、HTTP 写操作和 WebSocket 来源校验。
- USB/网络设备发现、网络连接与断开、设备地址识别。
- 设备记录保存到根目录 `.data/devices.json`：成功连接的网络地址及检测到的已授权在线设备自动记录，包含 `serial`、`model`、`transport`、`note`（备注）和 `lastConnectedAt`（毫秒时间戳），按设备标识去重，按最近连接时间排序。连接失败、未授权设备不入库；断开或服务重启不清空记录。
- 工具栏和“添加设备”中的“已保存设备”可查看历史记录，选择在线设备或重连可用的网络地址。每条记录可编辑备注（最多 120 个字符，自动去除首尾空格，留空清除），有备注时优先显示备注，保留型号和地址。旧记录默认无备注，轮询和重连不会覆盖备注，备注不会改变连接地址。离线 USB 和无线发现服务标识不能直接按地址重连。删除记录需确认，不会断开设备；当前服务连续观察到同一在线设备时不会立即补回，重新连接、离线后再次出现或服务重启后再次发现时可重新记录。
- WebP 截图下载、H.264 实时画面、画面点击、长按、跟手滑动及横竖屏坐标映射。
- scrcpy control 通道、浏览器播放状态、超时检测、设备切换清理、异常退出和服务关闭时释放转发端口。
- 返回、主页、任务列表、唤醒、锁屏、音量、确认、包名启动应用及文本输入。
- 文本输入使用 Android `input text`，仅支持接口校验允许的英文、数字及常用符号，不支持中文输入法注入。
- 当前投屏不包含音频；网页通过同一 WebSocket 的 scrcpy control 通道发送单指 `down`、`move`、`up` 和 `cancel`，支持实时点击、长按和滑动，不支持多指手势。
- 每个登录会话最多一个投屏，同一设备只允许一个会话投屏；其他管理员仍可发送 ADB 控制命令，此限制不是完整设备租约。
- H.264 连接中断后需重新点击投屏，以重新获取解码参数；页面刷新会停止当前 Cookie 会话的旧投屏。同一会话不支持多个标签页同时观看。
- 服务重启保留未到期的登录会话，但不恢复正在进行的投屏；日志只保留在当前浏览器内存，不是审计存储。
- 推荐当前版本 Chrome/Edge。设备编码器与浏览器必须支持 H.264 MediaSource。

## 结构与验证

```text
apps/api/src/    配置、认证、ADB、设备控制、视频会话和 HTTP 入口
apps/web/src/    Vue 入口、功能模块、可复用组件、组合式逻辑和 API 客户端
vendor/         复用的 scrcpy-server-v4.0 二进制及第三方许可证
docs/            架构和维护说明
```

```powershell
npm run lint
npm run format:check
npm test
npm run build
npm run check
```

前端按认证、设备、投屏、布局和公共组件拆分，`App.vue` 只负责认证入口，工作台通过异步组件加载。后端按配置、认证、设备和投屏生命周期拆分，HTTP DTO 校验和 ADB 进程边界集中在 API 工作区。

后端测试包含解析、认证、Cookie 时长、会话重启恢复、退出持久撤销、过期与改密失效、来源检查、DTO 校验及模拟 ADB 的投屏生命周期；前端测试覆盖缩放留白与旋转坐标。自动化测试不代表已完成真机编码器、设备旋转和浏览器视频联调。

设备记录测试使用临时 JSON 和模拟 ADB，覆盖去重、失败不入库、型号更新、重启恢复、接口鉴权及删除不触发断开。JSON 通过临时文件写入后重命名替换，仅支持单实例写入，不支持多个服务进程共用 `.data`。首次保存设备时自动创建文件；损坏的记录文件会阻止启动，修复前请先备份，不会被静默覆盖。

本机验收已通过开发代理下的真实登录、Cookie 属性、跨源拦截和退出失效检查。浏览器模拟设备检查覆盖空设备禁用状态、切换设备时丢弃旧截图、快捷键目标设备、桌面与窄屏布局；浏览器生成的 H.264 Annex B 测试帧已通过 JMuxer 播放并通过像素检查。这些模拟检查不包含真实 WebSocket 转发和 scrcpy 编码器。当前 `adb devices -l` 没有连接设备，真机截图、投屏、触控与旋转仍需接入授权设备后验收。

scrcpy 为 Genymobile 的独立开源项目，来源为 https://github.com/Genymobile/scrcpy 。随仓库保存的 server 二进制 SHA-256 与上游 v4.0 发布资产一致，核验记录见 [第三方组件说明](docs/third-party.md)。外部分发前仍须核验完整许可证与通知义务。

## 开源协作

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[SUPPORT.md](SUPPORT.md) 和 [架构说明](docs/architecture.md)。项目自身许可证尚待维护者选择；在明确授权前，不应将公开仓库视为已获得开源使用、修改或再分发授权。第三方许可证不覆盖本项目代码，详见 [第三方组件说明](docs/third-party.md)。

自动化测试使用模拟 ADB、TCP 和浏览器媒体帧，不能替代真实 Android 设备验收。当前尚未完成真机截图、scrcpy 编码器、触控和旋转的完整验证。
