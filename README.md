# ADB Desk

基于 ADB 与 scrcpy 的自托管 Android 网页远程控制台，支持实时投屏、远程触控和设备管理。

独立运行，不依赖旧项目。后端使用 NestJS 11 + Fastify 5 + TypeScript，前端使用 Vue 3 + TDesign Vue Next + Vite。

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

Compose 项目和服务名称均为 `adb-desk`，默认使用 Docker Hub 镜像 `wishmelz/adb-desk:latest`，支持 `linux/amd64` 和 `linux/arm64`，Docker 自动选择对应架构；默认容器名为 `adb-desk-adb-desk-1`（可由 `-p` 或 `COMPOSE_PROJECT_NAME` 覆盖项目名）。

默认部署只需 `compose.yaml` 和按需配置的 `.env`，无需安装 Node.js 或本地构建。现有 `.data` 可随部署目录迁移以保留访问密码、登录会话和设备记录，不要将其打入镜像或公开分享。如需自行构建，在源码目录依次执行 `npm ci`、`npm run build` 和 `docker build -t adb-desk:local .`，再将 Compose 的 `image` 改为 `adb-desk:local`。

当前 Docker 镜像固定使用 Node.js `22.23.4-slim`。镜像构建时不写入管理员密码；端口和密码在容器启动时通过环境变量定义：

```powershell
$env:PORT = '23120'
$env:ADMIN_PASSWORD = '请替换为自己的非空密码'
docker compose pull adb-desk
docker compose up -d adb-desk
```

上述配置会将宿主机 `23120` 映射到容器 `23120`。也可以在项目根目录 `.env` 中设置 `PORT`、`ADMIN_PASSWORD` 和可选的 `BIND_IP`，再执行 Compose 命令。修改密码或端口后需要重新创建容器：

```powershell
docker compose up -d --force-recreate adb-desk
```

不要把真实密码写入 `Dockerfile`、镜像构建参数或提交到 Git；`.env` 已被忽略，密码也可以由部署平台的 Secret 注入。

在 Linux 部署目录执行：

```sh
mkdir -p .data
chown -R 1000:1000 .data
chmod 700 .data
docker compose pull adb-desk
docker compose up -d --wait adb-desk
```

更新到最新镜像时，再次执行 `docker compose pull adb-desk` 和 `docker compose up -d --wait adb-desk`。

默认只发布 `127.0.0.1:23110`；受信局域网部署可在服务器 `.env` 中设置 `BIND_IP=192.168.3.11` 等实际网卡地址。此配置采用 HTTP，不应新增公网转发；公网访问需另行配置 HTTPS/VPN。容器以非 root 用户运行，设置自动重启、健康检查、日志轮转和 256 MiB 内存上限。用 `docker compose logs --tail 100 adb-desk` 查看日志，`docker compose restart adb-desk` 重启，`docker compose down` 停止但保留 `.data`。

从旧版 `adb-console` 服务 / `new-node-adb:local` 镜像升级时，先在原部署目录、使用旧 Compose 文件和原项目名执行 `docker compose down`（不要添加 `-v`），再更新配置，依次执行 `docker compose pull adb-desk` 和 `docker compose up -d --wait adb-desk`。若原部署使用了 `-p` 或 `COMPOSE_PROJECT_NAME`，停止旧容器时也必须使用同一项目名。不要直接启动第二套服务，否则旧容器可能继续占用端口；保留原 `.data` 绑定目录和 `.env`，密码、2FA、设备记录及 ADB 密钥无需迁移格式。已有验证器条目可能仍显示旧名称，但验证码继续有效；新绑定显示 `ADB Desk`。

容器内 ADB 与宿主机 ADB 隔离，当前部署针对网络设备连接，不接管现有 ADB 服务、USB 设备或已有连接。首次连接手机可能需重新授权；ADB 密钥保存在 `.data/.android`，容器重建后保留。需要 USB 时应单独配置设备访问权限，不能仅靠本配置发现宿主机 USB。

### 方案一：R2S + FRP

推荐将生产项目、ADB 和 scrcpy 转发运行在 R2S，公网服务器只运行 Nginx 和 frps。视频由手机编码，R2S 不转码；ADB 连接与启动控制都留在家庭局域网。R2S 可直接通过上述 Compose 命令拉取 ARM64 发布镜像，无需在路由器上构建前后端或镜像。

```text
浏览器 HTTPS/WSS
	-> 公网服务器 Nginx :443
	-> 公网服务器 frps 127.0.0.1:23110
	-> TLS 隧道 -> R2S frpc
	-> R2S 127.0.0.1:23110 -> NestJS + ADB
	-> 局域网 Android（scrcpy 编码）
```

以下示例使用同一稳定版本的 frpc/frps 和 TOML 配置，假设 Nginx/frps 在公网宿主机运行、frpc 在 R2S 宿主机运行。项目使用现有 Compose，保留 `BIND_IP=127.0.0.1`。若 frpc 在其他容器中，`127.0.0.1` 指向它自身，应改用共享网络的项目服务名和容器端口，不能直接套用宿主机地址。

公网 frps 配置：

```toml
bindPort = 7000
proxyBindAddr = "127.0.0.1"
allowPorts = [{ single = 23110 }]
auth.method = "token"
auth.token = "{{ .Envs.FRP_TOKEN }}"
transport.tls.force = true
transport.tls.certFile = "/etc/frp/tls/server.crt"
transport.tls.keyFile = "/etc/frp/tls/server.key"
```

R2S frpc 配置：

```toml
serverAddr = "frp.example.com"
serverPort = 7000
loginFailExit = false
auth.method = "token"
auth.token = "{{ .Envs.FRP_TOKEN }}"
transport.protocol = "tcp"
transport.tls.enable = true
transport.tls.trustedCaFile = "/etc/frp/tls/ca.crt"
transport.tls.serverName = "frp.example.com"

[[proxies]]
name = "adb-desk"
type = "tcp"
localIP = "127.0.0.1"
localPort = 23110
remotePort = 23110
transport.useCompression = false
```

将域名改为实际公网主机地址。先部署匹配 `serverName` 的服务端证书与私钥，R2S 的 `ca.crt` 是签发该证书的可信 CA；只复制 CA 公共证书，不复制服务端私钥。不要通过关闭证书校验解决连接错误。`FRP_TOKEN` 是独立于控制台密码的强随机共享密钥，通过两端进程环境注入且必须一致；真实配置和密钥放在仓库外并限制读取权限。现有 `.env` 不会自动成为宿主机 frpc/frps 的环境变量。

先在对应机器运行 `frps verify -c /etc/frp/frps.toml` 和 `frpc verify -c /etc/frp/frpc.toml`，再交给各自的 systemd/procd 服务管理器自动启动和异常重启。FRP 重连可恢复隧道，但已中断的视频需在页面重新启动，以获取完整解码参数。配置字段可查阅 [FRP 官方文档](https://gofrp.org/en/docs/reference/)。

公网服务器复用 [Nginx 示例](deploy/nginx/adb-console.conf)，上游 `127.0.0.1:23110` 此时是 frps 监听端口。保留 WebSocket upgrade、`proxy_buffering off` 和长连接超时。只向浏览器开放 HTTPS；FRP 的 TCP 7000 仅供 frpc 连接，条件允许时限制来源。不要对公网开放 23110、ADB 5037 或手机调试端口，也不需要给手机配置 FRP。

在 R2S 项目根目录 `.env` 设置：

```dotenv
PUBLIC_ORIGIN=https://adb.example.com
COOKIE_SECURE=true
STREAM_MAX_SIZE=1280
STREAM_MAX_FPS=30
STREAM_BIT_RATE=3000000
STREAM_MAX_SESSIONS=2
```

这些值是服务端默认值和请求上限，客户端可以请求更低参数，但不能突破部署限制。并发上限包含正在启动和等待观看的投屏；当前采用单登录会话且每个会话最多一路，因此实际最多一路，提高 `STREAM_MAX_SESSIONS` 不会允许多个浏览器独立登录并发投屏。同一会话切换设备会替换自己的投屏，新登录会先释放旧登录的投屏。配置在启动时读取，Compose 修改后执行 `docker compose up -d --force-recreate`；非 Docker 部署重启 API，对之后新建的投屏生效。

#### 家庭上行预算

`7 MB/s` 约为 `56 Mbps`，与 `7 Mbps` 差八倍。默认单路目标码率为 `3 Mbps = 0.375 MB/s`，不含隧道和协议开销。这里限制的是编码器目标码率，不是网络硬限速，关键帧和画面变化可能产生突发；它也不保证不同手机编码器都达到相同帧率或清晰度。

若测速结果其实是 **7 Mbps**，先使用以下保守单路配置：

```dotenv
STREAM_MAX_SIZE=960
STREAM_MAX_FPS=20
STREAM_BIT_RATE=1500000
STREAM_MAX_SESSIONS=1
```

- 先降低码率和并发，再按画面需要调整长边与帧率。默认不传音频；H.264 已压缩，WebSocket 和 FRP 不再做压缩，减少 R2S CPU 消耗。
- 不把 FRP 限速设为与视频目标码率相同或更低，否则突发视频和 API 请求会排队。确需设置时应为视频、页面、截图和协议开销保留余量；优先用路由器已有的 SQM/QoS 防止其他上传占满出口，数值按实测上行调整，不由本项目改动路由器。
- 浏览器积压超过约两秒目标码率对应的数据量时，后端结束投屏并清理编码进程与 ADB 转发；最低队列预算 256 KiB。该预算不是端到端延迟保证，不包含 FRP、系统和浏览器内部队列，也不通过丢弃任意 H.264 数据维持播放。
- 每 15 秒检查 WebSocket ping/pong，无响应会在约 15-30 秒内清理，静止画面不会被误判为断线。恢复网络后需重新点击投屏。

上线时测试一路投屏及不同浏览器登录接管，观察 R2S CPU/内存、路由器 WAN 上传和触控延迟，并检查断网后会话与 ADB 转发能否释放。当前默认值是保守起点，尚未在真实 R2S、FRP 和用户家庭链路上测量，不代表硬件性能承诺。

## 配置

按需以 `.env.example` 为基础创建根目录 `.env`，或设置同名环境变量：

| 变量                   | 默认值 / 作用                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `HOST`                 | `127.0.0.1`；仅本机监听                                                                                    |
| `PORT`                 | `23110`                                                                                                    |
| `ADMIN_PASSWORD`       | 留空时使用本机密码文件（不存在则生成）；自定义密码非空即可，无固定长度限制，公网建议使用长随机密码         |
| `SESSION_HOURS`        | `24`；从登录时起计算的有效小时数，须为不小于 24 的整数，例如 `168` 表示 7 天；修改后重启服务，对新登录生效 |
| `LOGIN_MAX_ATTEMPTS`   | `5`；同一来源 IP 在限流窗口内允许的失败次数                                                                |
| `LOGIN_WINDOW_MINUTES` | `15`；登录失败计数窗口，范围为 1-1440 分钟                                                                 |
| `STREAM_MAX_SIZE`      | `1280`；视频长边上限，范围 480-1920                                                                        |
| `STREAM_MAX_FPS`       | `30`；视频帧率上限，范围 10-60                                                                             |
| `STREAM_BIT_RATE`      | `3000000`；单路编码目标码率上限，单位 bit/s，范围 500000-12000000                                          |
| `STREAM_MAX_SESSIONS`  | `2`；当前服务实例的投屏并发上限，范围 1-16                                                                 |
| `ADB_PATH`             | `adb`；也可填 adb.exe 绝对路径                                                                             |
| `SCRCPY_SERVER_PATH`   | `vendor/scrcpy-server-v4.0` 的绝对路径                                                                     |
| `SCRCPY_VERSION`       | `4.0`；必须与二进制版本匹配                                                                                |
| `PUBLIC_ORIGIN`        | 留空采用请求 Host 同源检查；反向代理部署填完整页面源，如 `https://adb.example.com`，不带末尾斜杠           |
| `COOKIE_SECURE`        | `false`；HTTPS 部署设为 `true`                                                                             |

登录 Cookie 与服务端会话有效期一致，默认登录后 24 小时内无需重复登录，不按午夜清零。刷新页面、关闭后重新打开浏览器或重启服务不会使未到期会话失效；主动退出、清除 Cookie、更换访问密码或被新登录替换后需重新登录。会话以令牌摘要而非明文令牌保存在 `.data/sessions.json`，部署时需保留并保护 `.data`。从旧版内存会话升级后需重新登录一次；旧版持久化文件含多个会话时，仅保留最后创建且未过期的会话。

系统只允许一个有效登录会话：新登录完成全部认证后撤销旧令牌，并等待旧投屏、scrcpy 进程和 ADB 转发清理完成后返回。启用 2FA 时，仅密码正确还不会接管，需继续完成验证码验证，或通过仍有效的可信浏览器校验。旧投屏页面收到 WebSocket 关闭通知后回到登录页，提示账号已在其他位置登录；未投屏的旧页面在后续 API 请求（包括设备轮询）返回 401 时退出。输错密码或验证码不会踢掉当前会话，同时登录时以最后一次完成全部认证的登录为准。不会执行全局 `adb disconnect`，不会删除设备记录，新登录可直接选择原设备重新投屏。同一浏览器共享 Cookie 的标签页属于同一个会话，不是独立登录；该机制仅适用于单服务实例，不是第三方身份提供商的 SSO。

反向代理必须转发 WebSocket upgrade。不要直接将 ADB 或此控制台暴露到公网；远程访问应通过 HTTPS、VPN 或受控网络。开发服务器默认仅绑定本机。

### 可选双重验证（2FA）

默认关闭，无需额外环境变量。登录后点击顶部“安全设置”，开启“验证器双重验证”，重新输入访问密码开始绑定。使用 Microsoft Authenticator、Google Authenticator、Aegis 等支持 TOTP 的验证器扫描二维码，也可手动输入密钥；提交验证器的 6 位验证码后才正式启用。绑定请求有效期为 10 分钟，尚未完成绑定不会改变原登录方式。

启用后会显示 **10 个一次性恢复码，仅显示这一次**。下载并离线妥善保存，确认保存后关闭窗口；丢失验证器时可在验证码输入框使用恢复码，每个只能使用一次。不要把恢复码和绑定密钥放进仓库、日志或公开截图。验证码每 30 秒刷新，允许相邻时间窗口的时钟偏差，同一个时间步的验证码不能重复使用；连续执行安全操作时请等待新验证码，服务器与手机应启用时间同步。

重新登录时先输入密码，再输入验证码或恢复码。第二步可勾选“此浏览器免 2FA”，填写 **1-90 天**（勾选后默认 7 天）；不勾选则只验证此次登录。此设置仅信任当前浏览器配置文件和访问站点，并非识别物理设备：换浏览器、使用隐私窗口、清除 Cookie 或超过期限后需重新验证。有效期从此次验证成功开始计算，不因后续登录自动延长。

- **免 2FA 不等于免密码**：登录会话失效后仍需输入访问密码；会话有效期继续由 `SESSION_HOURS` 控制。
- 主动退出只结束当前会话，不取消此浏览器的免验证期限。安全设置可查看可信浏览器数量、当前浏览器免验证期限和剩余恢复码数量。
- “撤销所有免验证浏览器”需要密码及新验证码或未使用的恢复码，所有可信令牌立即失效，但不会主动退出当前会话。关闭 2FA 也需要相同校验，且会清除绑定、恢复码和所有可信浏览器记录；之后可以重新绑定。
- 密码正确后生成的登录验证请求有效期为 5 分钟，绑定到来源 IP，单次最多尝试 5 次；密码、验证码和安全设置失败还受 `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` 限制。刷新登录页或重启服务后需重新输入密码。

2FA 数据保存在会话文件同目录的 `.data/two-factor.json`。恢复码和可信令牌只保存摘要；TOTP 密钥必须保留原值以校验动态验证码，因此应保护整个 `.data` 目录和备份，不要将其打进镜像。生产使用 HTTPS 并设置 `COOKIE_SECURE=true`，可信 Cookie 为 `HttpOnly`、`SameSite=Strict`，路径限制为 `/api/auth`。更换管理员密码会使原会话、可信令牌和恢复码失效，但不会关闭 TOTP；更换后使用验证器登录，并关闭再重新绑定以生成新恢复码。不要删除 2FA 数据文件来执行常规升级，否则会清除保护；损坏文件会阻止启动，应恢复受保护备份。

自动化测试覆盖绑定、验证码防重放、恢复码、HTTP Cookie、到期/撤销、存储写入失败和完整认证后的 WebSocket 接管。真实验证器扫码、R2S/FRP 和公网链路仍需上线验收。

## 功能与边界

- Cookie 登录、退出、新登录接管旧登录、默认 24 小时可配置持久化会话、登录失败限流、HTTP 写操作和 WebSocket 来源校验。
- 可选 TOTP 双重验证、一次性恢复码、当前浏览器可设置 1-90 天免 2FA、可信浏览器统一撤销。
- USB/网络设备发现、网络连接与断开、设备地址识别。
- 设备记录保存到根目录 `.data/devices.json`：成功连接的网络地址及检测到的已授权在线设备自动记录，包含 `serial`、`model`、`transport`、`note`（备注）和 `lastConnectedAt`（毫秒时间戳），按设备标识去重，按最近连接时间排序。连接失败、未授权设备不入库；断开或服务重启不清空记录。
- 工具栏和“添加设备”中的“已保存设备”可查看历史记录，选择在线设备或重连可用的网络地址。每条记录可编辑备注（最多 120 个字符，自动去除首尾空格，留空清除），有备注时优先显示备注，保留型号和地址。旧记录默认无备注，轮询和重连不会覆盖备注，备注不会改变连接地址。离线 USB 和无线发现服务标识不能直接按地址重连。删除记录需确认，不会断开设备；当前服务连续观察到同一在线设备时不会立即补回，重新连接、离线后再次出现或服务重启后再次发现时可重新记录。
- WebP 截图下载、H.264 实时画面、画面点击、长按、跟手滑动及横竖屏坐标映射。
- scrcpy control 通道、浏览器播放状态、超时检测、设备切换清理、异常退出和服务关闭时释放转发端口。
- 返回、主页、任务列表、唤醒、锁屏、音量、确认、包名启动应用及文本输入。
- 文本输入使用 Android `input text`，仅支持接口校验允许的英文、数字及常用符号，不支持中文输入法注入。
- 当前投屏不包含音频；网页通过同一 WebSocket 的 scrcpy control 通道发送单指 `down`、`move`、`up` 和 `cancel`，支持实时点击、长按和滑动，不支持多指手势。
- 全局只保留一个登录会话，该会话最多一个投屏；新登录会断开旧投屏和控制连接，旧令牌不能再调用控制 API。已经在设备上执行的 ADB 命令不会回滚，此限制不是跨服务或跨 ADB 客户端的设备租约。
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

后端测试包含解析、认证、Cookie 时长、会话重启恢复、旧多会话文件迁移、退出持久撤销、过期与改密失效、来源检查、DTO 校验及模拟 ADB 的投屏生命周期。登录接管测试覆盖真实 HTTP/WebSocket 旧连接关闭、旧令牌失效、失败登录不踢人、启动中接管、并发登录以及同设备即时重用；前端测试覆盖被替换通知后的播放器清理、返回登录页、缩放留白与旋转坐标。自动化测试不代表已完成真机编码器、设备旋转和浏览器视频联调。

设备记录测试使用临时 JSON 和模拟 ADB，覆盖去重、失败不入库、型号更新、重启恢复、接口鉴权及删除不触发断开。JSON 通过临时文件写入后重命名替换，仅支持单实例写入，不支持多个服务进程共用 `.data`。首次保存设备时自动创建文件；损坏的记录文件会阻止启动，修复前请先备份，不会被静默覆盖。

本机验收已通过开发代理下的真实登录、Cookie 属性、跨源拦截和退出失效检查。浏览器模拟设备检查覆盖空设备禁用状态、切换设备时丢弃旧截图、快捷键目标设备、桌面与窄屏布局；浏览器生成的 H.264 Annex B 测试帧已通过 JMuxer 播放并通过像素检查。这些模拟检查不包含真实 WebSocket 转发和 scrcpy 编码器。当前 `adb devices -l` 没有连接设备，真机截图、投屏、触控与旋转仍需接入授权设备后验收。

scrcpy 为 Genymobile 的独立开源项目，来源为 https://github.com/Genymobile/scrcpy 。随仓库保存的 server 二进制 SHA-256 与上游 v4.0 发布资产一致，核验记录见 [第三方组件说明](docs/third-party.md)。外部分发前仍须核验完整许可证与通知义务。

## 开源协作

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[SUPPORT.md](SUPPORT.md) 和 [架构说明](docs/architecture.md)。项目自身许可证尚待维护者选择；在明确授权前，不应将公开仓库视为已获得开源使用、修改或再分发授权。第三方许可证不覆盖本项目代码，详见 [第三方组件说明](docs/third-party.md)。

自动化测试使用模拟 ADB、TCP 和浏览器媒体帧，不能替代真实 Android 设备验收。当前尚未完成真机截图、scrcpy 编码器、触控和旋转的完整验证。
