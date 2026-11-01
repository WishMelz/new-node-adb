# ADB Desk

基于 ADB 与 scrcpy 的自托管 Android 网页远程控制台，支持实时投屏、远程触控和设备管理。

独立运行，不依赖旧项目。后端使用 NestJS 11 + Fastify 5 + TypeScript，前端使用 Vue 3 + TDesign Vue Next + Vite。

## 技术选择

- NestJS 管理认证、设备与远程控制模块的依赖和生命周期；Fastify 负责 HTTP、Cookie 和静态资源。
- ADB 通过参数化子进程调用，所有设备操作显式传入 serial，并进行 DTO 和设备就绪校验。
- scrcpy 4.0 输出 H.264，经 WebSocket 传输，由 JMuxer 转封装为浏览器 MediaSource 可播放的 MP4。
- 单管理员密码 + 本地持久化会话适用于单实例、本地/受信网络设备管理，不引入数据库；不等同于多租户权限系统。

## 运行

需要 Node.js 22.13+、npm、Android Platform Tools，以及开启调试的 Android 设备。项目使用独立的 ADB 身份和 server；系统 `adb devices` 中已授权的设备，需要先导入原身份或在手机上授权项目的新身份。

在本目录运行：

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

- 开发界面：`http://127.0.0.1:23111`
- API：`http://127.0.0.1:23110/api/health`
- 首次配置时复制示例；已有 `.env` 时不要覆盖。开发界面读取 `DEV_WEB_PORT`（默认 `23111`），API 读取 `DEV_API_PORT`（默认 `23110`），不使用 `DOCKER_PORT`。
- Vite 自动将 `/api` 和 `/ws` 代理到 `DEV_API_PORT`。两个开发端口必须不同，被其他程序占用时直接报错。监听地址固定为 `0.0.0.0`，不提供 HOST 设置。
- `DATA_DIR` 留空时使用项目根目录 `.data`，相对路径以项目根目录为基准，也支持绝对路径。会话、设备记录、两步验证、初始密码及 ADB 密钥保存在该目录；更换目录前应停服并迁移原数据，不会自动搬迁或覆盖旧目录。
- 未配置 `ADMIN_PASSWORD` 时，服务首次启动生成随机密码，保存在 `DATA_DIR` 下的 `bootstrap-password`。请在本机查看，不要提交或分享该文件。
- `.data`、`.env`、构建产物和依赖目录均已忽略；自定义数据目录建议放在仓库外，否则需自行加入 Git 和 Docker 忽略规则。Windows 下请使用当前用户的文件权限保护数据目录，POSIX 文件权限参数不等同于 Windows ACL。

开发环境保留两个独立项目和进程，`npm run dev` 只负责同时启动它们；也可在两个终端分别运行 `npm run dev -w @adb/api` 和 `npm run dev -w @adb/web`，前端使用 Vite 热更新，不依赖前端构建产物。

### ADB 密钥持久化与导入

所有运行方式统一使用 `DATA_DIR/.android/adbkey` 和 `adbkey.pub`。首次设备操作时自动初始化，也可提前执行 `npm run adb:identity -- init`。已有私钥不会被覆盖；缺少公钥时从原私钥恢复，只有公钥、密钥损坏或两者不匹配时直接报错。重启项目或重建容器后，只要保留数据目录，再次连接设备就会使用原身份，不需要因项目重启而重复授权。设备撤销授权、恢复出厂或无线配对凭据变化仍可能要求重新授权。

项目不自动读取系统私钥。希望复用宿主机已有授权时，先停止使用该数据目录的项目，再显式导入 **私钥**；同目录的公钥若存在，也会校验一致性。只导入 `adbkey.pub` 无法完成认证。

Windows PowerShell，在项目目录中执行：

```powershell
npm run adb:identity -- import "$env:USERPROFILE\.android\adbkey"
npm run adb:identity -- status
```

macOS / Linux：

```bash
npm run adb:identity -- import "$HOME/.android/adbkey"
npm run adb:identity -- status
```

`status` 只读检查并显示目录、公钥是否存在和 SHA-256 公钥指纹，不显示私钥，也不启动 server。相同身份重复导入无副作用；目标已有不同身份时拒绝覆盖，没有强制覆盖开关。若确需切换身份，先停服并将整个 `.android` 移到受保护的备份位置，再执行导入；回滚时停服恢复该备份。切换后，仅授权旧身份的设备需要重新授权。

宿主机直接运行和 Docker 要共享授权，应使用同一 `DATA_DIR` 或向各自数据目录导入同一私钥。Compose 已将宿主数据目录挂载至 `/app/.data`，因此可以在宿主机通过上述命令导入后再启动容器；Docker 不会自动访问宿主机的 `~/.android`。只有镜像时，可将源密钥目录只读挂载到一次性容器，再执行镜像内的 CLI（使用本次代码构建的镜像，示例为 macOS / Linux）：

```bash
docker run --rm --network none \
	--mount "type=bind,source=/absolute/data,target=/app/.data" \
	--mount "type=bind,source=$HOME/.android,target=/key-source,readonly" \
	adb-desk:local node apps/api/dist/adb-identity-cli.js import /key-source/adbkey
```

源文件需要容器运行用户可读、目标目录需要可写；不要为方便导入将私钥改为全员可读。Mac 和 Windows 无需默认共享同一个身份，可分别导入各自主机已有授权的密钥。Android 11+ 无线调试的配对不等同于传统 TCP ADB 授权，复制密钥不保证免配对。

密钥目录在 POSIX 下限制为 `0700`，密钥文件为 `0600`；Windows 继承数据目录 ACL，请将 `DATA_DIR` 设置为仅运行用户及受信任管理员可访问。初始化通过同文件系统硬链接原子发布，需使用支持硬链接的本地文件系统（如 NTFS、APFS、ext4），不支持时会报错而不是降级覆盖。强制终止初始化可能留下 `.android/.init-*` 临时目录，确认所有实例已停后可删除这些临时目录，不要删除正式密钥。备份含私钥，必须受保护，禁止提交到 Git、打入镜像或通过网页上传/下载。

项目在首次设备操作时启动自有前台 ADB server，使用动态回环端口，客户端显式指定该端口；不会连接或关闭系统 `5037` server。正常退出先停止投屏，再关闭自有 server。关闭 mDNS 自动连接及模拟器端口扫描，不自动重连历史网络设备，重启后由用户重新连接。独立 server 不解决 USB 争用或 Docker Desktop USB 透传问题。

### 生产部署

```powershell
npm run build
$env:NODE_ENV = 'production'
npm start
```

`npm run build` 编译前后端，静态构建不读取开发端口。`npm start` 只启动 NestJS，不运行 Vite；`NODE_ENV=production` 时监听 `0.0.0.0:DOCKER_PORT`（默认 `23120`），其他模式读取 `DEV_API_PORT`。Linux 可使用 `NODE_ENV=production npm start`；返回开发模式前清除终端中的 `NODE_ENV` 或设为 `development`。NestJS/Fastify 从 `apps/web/dist` 提供首页和静态资源，同一端口提供 `/api` 和 `/ws`，默认访问 `http://127.0.0.1:23120`。更新前端后应重新构建并重启后端，部署须包含 `apps/api/dist`、`apps/web/dist`、`vendor` 及 API 生产依赖，保留 `DATA_DIR`。Docker 自动设置 production 模式，不安装或运行 Nginx。

### Nginx 域名入口

需要公网域名和 HTTPS 时，可在应用外部配置 Nginx；这是可选入口，不属于应用容器，且不转发到 Vite：

```text
浏览器 https://adb.example.com
	-> Nginx :443（TLS 终止、HTTP/WebSocket 反向代理）
	-> NestJS 127.0.0.1:23120
			 /、/assets/*  -> apps/web/dist
			 /api/*       -> 后端 API
			 /ws/*        -> 投屏 WebSocket
```

在运行后端的机器上，通过项目根目录 `.env` 配置端口和 Cookie；开发环境保持原有 HTTP 配置，无需填写公网域名：

```dotenv
DOCKER_PORT=23120
COOKIE_SECURE=true
```

使用 [Nginx 示例配置](deploy/nginx/adb-console.conf)，替换其中的域名和 TLS 证书路径；直接代理应用时将上游端口改为 `DOCKER_PORT`（默认 `23120`），示例保留的 `23110` 用于下文 FRP 公网转发端口。将配置放入服务器由 Nginx `http` 块包含的配置目录（通常为 `/etc/nginx/conf.d/`）。文件包含 `map` 和完整 `server` 块，不能直接嵌入已有的 `server` 块。证书须提前签发并部署；示例不包含证书申请流程。在服务器完成配置后执行 `nginx -t`，确认通过再重载 Nginx。

所有路径原样代理到后端端口，前端继续使用同源 `/api` 和 `/ws`，无需写死域名或开放 CORS。WebSocket 升级头和长连接超时已配置；不要移除升级头，也无需改写浏览器的 `Origin`。HTTP 和 WebSocket 不再按 `Origin` 与上游 `Host` 限制访问，旧的 `PUBLIC_ORIGIN` 配置已不生效。`COOKIE_SECURE` 仅控制 Cookie 是否要求浏览器使用 HTTPS，TLS 在 Nginx 终止后，上游仍可使用 HTTP；设置为 `true` 后，本地 HTTP 登录不能正常使用会话。

示例假设 Nginx 与后端位于同一台服务器，生产上游为 `127.0.0.1:DOCKER_PORT`，默认 `127.0.0.1:23120`。Compose 使用 host 网络，不再有 bridge 网络服务名 `adb-desk`；同机 host 网络容器可使用回环地址，bridge 网络中的代理应使用可达的宿主机地址，不能使用其自身的 `127.0.0.1`。应用监听全部 IPv4 网卡；公网部署请通过防火墙或云安全组限制应用端口，仅开放 HTTPS/VPN 入口。当前后端未开启对代理 IP 头的信任，限流按上游代理来源聚合，不会仅凭客户端传入的转发头识别 IP。

上线验收：访问域名首页和 `/api/health`；确认登录 Cookie 带 `Secure`；启动投屏时确认 `/ws/streams/...` 返回 `101 Switching Protocols`。当前前端没有 history 路由，不配置未知路径回退，缺失的 API 和静态资源仍返回 404。

### Docker 部署

Compose 项目和服务名称均为 `adb-desk`，默认使用 Docker Hub 镜像 `wishmelz/adb-desk:latest`，支持 `linux/amd64` 和 `linux/arm64`，Docker 自动选择对应架构；默认容器名为 `adb-desk-adb-desk-1`（可由 `-p` 或 `COMPOSE_PROJECT_NAME` 覆盖项目名）。

部署配置需要 `compose.yaml` 和 `.env`，使用 Docker Compose 2.24.0 或更新版本。此次环境变量改动尚未发布到 Docker Hub，当前源码应先在源码目录执行 `npm ci`、`npm run build` 和 `docker build -t adb-desk:local .`，再将 Compose 的 `image` 改为 `adb-desk:local`；不要直接用旧 `latest` 验证新配置。发布匹配版本后可直接拉取镜像，无需安装 Node.js 或本地构建。保留 `DATA_DIR` 内的数据，不要将其打入镜像或公开分享。

当前 Dockerfile 使用 Node.js `22.23.4-slim`，只启动后端应用进程，不安装 Nginx，也不运行 Vite。密码和端口统一填写在 Compose 同目录的 `.env` 配置文件中，可参考 `.env.example`：

```dotenv
# 密码
ADMIN_PASSWORD=

# 配置目录 缓存配置文件位置
DATA_DIR=

# 开发配置
DEV_WEB_PORT=
DEV_API_PORT=

# Docker 部署配置
DOCKER_PORT=23120
```

```text
浏览器 / 宿主机 frpc
	-> 宿主机 DOCKER_PORT（默认 23120，host 网络，无端口映射）
	-> 容器 NestJS/Fastify :DOCKER_PORT
			 /、/assets/* -> apps/web/dist
			 /api/*      -> 后端 API
			 /ws/*       -> 投屏 WebSocket
```

Compose 使用 `network_mode: host`，没有 `ports` 映射。后端只读取 `DOCKER_PORT` 作为服务端口，忽略开发端口；健康检查也跟随该端口，所有请求由后端直接处理。宿主机 frpc 的 `localPort` 填写 `DOCKER_PORT`。直接使用 `docker run` 时采用 `--network host --env-file .env`，无需 `-p`，同时需挂载数据目录并将容器内 `DATA_DIR` 设为 `/app/.data`。

host 网络适用于 Linux Docker Engine；Docker Desktop 4.34+ 需在设置中启用 host networking，仅支持 Linux 容器，且与 Enhanced Container Isolation 不兼容。未启用时不能保证无映射端口可从宿主机访问。host 网络共享端口空间，端口被占用时应更改 `DOCKER_PORT` 或处理冲突，不会自动换端口。通过 HTTPS 入口访问时，按需追加 `COOKIE_SECURE=true`。

`DATA_DIR` 是宿主机持久化目录，留空为 Compose 同目录下的 `.data`；支持相对路径和绝对路径，挂载到容器 `/app/.data`，Compose 会覆盖容器内 `DATA_DIR=/app/.data`。容器内的 `HOME` 也指向此目录，ADB 密钥随数据持久化。Linux 目录需允许 UID/GID `1000:1000` 读写。更改 `DATA_DIR` 前应先停服、迁移原目录并保留权限；空目录将被视为全新实例。

旧配置迁移：将对外入口的 `PORT` 改为 `DOCKER_PORT`，开发端口分别使用 `DEV_WEB_PORT` 和 `DEV_API_PORT`，保留 `ADMIN_PASSWORD`。删除 `HOST`、`BIND_IP`、`FRONTEND_PORT`、`BACKEND_PORT`、`HOST_PORT` 等旧键，它们不再读取。

Compose 直接读取 `.env` 中的密码和 `DOCKER_PORT`，终端同名变量不会覆盖该文件；`DATA_DIR` 的挂载插值遵循 Compose 的环境变量优先规则。密码含 `$` 或 `#` 时使用单引号保留字面值。密码未配置或留空时使用数据目录下的 `bootstrap-password`，不存在则自动生成。修改配置后需要重新创建容器，单独 `restart` 不会更新容器配置：

```powershell
docker compose up -d --force-recreate adb-desk
```

不要把真实密码写入 `Dockerfile`、镜像构建参数或提交到 Git；`.env` 已被忽略且不会打入镜像。限制该文件的读取权限，不要公开配置输出或容器环境信息。

发布匹配的新镜像后，在 Linux 部署目录执行以下命令；使用自建镜像时省略 `pull`，自定义 `DATA_DIR` 时将命令中的 `.data` 替换为实际目录：

```sh
mkdir -p .data
chown -R 1000:1000 .data
chmod 700 .data
docker compose pull adb-desk
docker compose up -d --wait adb-desk
```

更新到最新镜像时，再次执行 `docker compose pull adb-desk` 和 `docker compose up -d --wait adb-desk`。

默认监听全部 IPv4 地址的 `23120`，不提供 HOST 设置。此配置采用 HTTP，公网访问需另行配置 HTTPS/VPN 和网络访问限制。后端以非 root 用户运行，进程退出后由自动重启策略恢复；健康检查直接请求后端。保留日志轮转和 256 MiB 内存上限。用 `docker compose logs --tail 100 adb-desk` 查看日志，`docker compose restart adb-desk` 重启，`docker compose down` 停止但保留数据目录。

从旧版 `adb-console` 服务 / `new-node-adb:local` 镜像升级时，先在原部署目录、使用旧 Compose 文件和原项目名执行 `docker compose down`（不要添加 `-v`），再更新配置，依次执行 `docker compose pull adb-desk` 和 `docker compose up -d --wait adb-desk`。若原部署使用了 `-p` 或 `COMPOSE_PROJECT_NAME`，停止旧容器时也必须使用同一项目名。不要直接启动第二套服务，否则旧容器可能继续占用端口；保留原 `.data` 绑定目录和 `.env`，密码、2FA、设备记录及 ADB 密钥无需迁移格式。已有验证器条目可能仍显示旧名称，但验证码继续有效；新绑定显示 `ADB Desk`。

当前部署针对网络设备连接。项目使用自有 ADB server 和动态回环端口，不复用宿主机 `5037`，无需添加 ADB 端口映射。已有 `DATA_DIR/.android` 密钥会被原样复用；此前实际连接的是宿主机 server 时，应显式导入宿主机已授权身份。需要 USB 时应单独配置设备访问权限，不能仅靠本配置发现宿主机 USB，也不要让多个 server 同时争用同一 USB 设备。

### 方案一：R2S + FRP

推荐将生产项目、ADB 和 scrcpy 转发运行在 R2S，公网服务器只运行 Nginx 和 frps。视频由手机编码，R2S 不转码；ADB 连接与启动控制都留在家庭局域网。R2S 可直接通过上述 Compose 命令拉取 ARM64 发布镜像，无需在路由器上构建前后端或镜像。

```text
浏览器 HTTPS/WSS
	-> 公网服务器 Nginx :443
	-> 公网服务器 frps 127.0.0.1:23110
	-> TLS 隧道 -> R2S frpc
	-> R2S 127.0.0.1:23120 -> host 网络容器 NestJS :23120 + ADB
	-> 局域网 Android（scrcpy 编码）
```

以下示例使用同一稳定版本的 frpc/frps 和 TOML 配置，假设 Nginx/frps 在公网宿主机运行、frpc 在 R2S 宿主机运行。若更改 `DOCKER_PORT`，需同步修改 frpc 的 `localPort`，公网 `remotePort` 不必跟随修改。frpc 若使用 host 网络可访问同机回环地址；若使用 bridge 网络，应配置可达的宿主机地址，不能使用其自身回环地址或 `adb-desk` 服务名。应用监听全部 IPv4 地址，应限制不受信网络访问。

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
localPort = 23120
remotePort = 23110
transport.useCompression = false
```

将域名改为实际公网主机地址。先部署匹配 `serverName` 的服务端证书与私钥，R2S 的 `ca.crt` 是签发该证书的可信 CA；只复制 CA 公共证书，不复制服务端私钥。不要通过关闭证书校验解决连接错误。`FRP_TOKEN` 是独立于控制台密码的强随机共享密钥，通过两端进程环境注入且必须一致；真实配置和密钥放在仓库外并限制读取权限。现有 `.env` 不会自动成为宿主机 frpc/frps 的环境变量。

先在对应机器运行 `frps verify -c /etc/frp/frps.toml` 和 `frpc verify -c /etc/frp/frpc.toml`，再交给各自的 systemd/procd 服务管理器自动启动和异常重启。FRP 重连可恢复隧道，但已中断的视频需在页面重新启动，以获取完整解码参数。配置字段可查阅 [FRP 官方文档](https://gofrp.org/en/docs/reference/)。

公网服务器复用 [Nginx 示例](deploy/nginx/adb-console.conf)，上游 `127.0.0.1:23110` 此时是 frps 监听端口。保留 WebSocket upgrade、`proxy_buffering off` 和长连接超时。只向浏览器开放 HTTPS；FRP 的 TCP 7000 仅供 frpc 连接，条件允许时限制来源。不要对公网开放 23110、ADB 5037 或手机调试端口，也不需要给手机配置 FRP。

在 R2S 项目根目录 `.env` 设置：

```dotenv
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

根目录 `.env` 使用以下五项配置，参考 `.env.example`。开发工具只读取两个 `DEV_` 端口，不会将密码或数据目录注入浏览器代码；静态构建不读取开发端口。修改后重启源码服务，Docker 执行 `docker compose up -d --force-recreate adb-desk`。

| 变量             | 留空默认值             | 作用                                                    |
| ---------------- | ---------------------- | ------------------------------------------------------- |
| `ADMIN_PASSWORD` | 自动生成或读取初始密码 | 登录密码                                                |
| `DATA_DIR`       | `.data`                | 本地数据目录；Compose 中为宿主机持久化目录              |
| `DEV_WEB_PORT`   | `23111`                | Vite 开发界面端口                                       |
| `DEV_API_PORT`   | `23110`                | 非 production 模式的后端端口及 Vite 代理目标            |
| `DOCKER_PORT`    | `23120`                | production/Docker 的静态页面、API 和 WebSocket 共用端口 |

端口范围为 `1-65535`，固定监听 `0.0.0.0`。开发端口必须不同，生产与 Docker 不运行 Vite。密码留空时使用数据目录下的 `bootstrap-password`，不存在则自动生成；自定义密码非空即可，公网建议使用长随机密码。不要将密码变量改为 `VITE_` 前缀。源码运行遵循进程环境变量优先规则，避免额外设置同名变量。下文 `.data/...` 均表示默认目录下的文件，自定义 `DATA_DIR` 时路径同步变化；本机和 Docker 的 ADB 均使用该目录内的身份，系统已有授权需显式导入。

### 高级配置

以下参数都有默认值，通常无需写入 `.env`。需要时再追加，Compose 直接传递文件中的参数，不再重复定义默认值：

| 变量                   | 默认值 / 作用                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
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
| `COOKIE_SECURE`        | `false`；HTTPS 部署设为 `true`                                                                             |

登录 Cookie 与服务端会话有效期一致，默认登录后 24 小时内无需重复登录，不按午夜清零。刷新页面、关闭后重新打开浏览器或重启服务不会使未到期会话失效；主动退出、清除 Cookie、更换访问密码或被新登录替换后需重新登录。会话以令牌摘要而非明文令牌保存在 `.data/sessions.json`，部署时需保留并保护 `.data`。从旧版内存会话升级后需重新登录一次；旧版持久化文件含多个会话时，仅保留最后创建且未过期的会话。

系统只允许一个有效登录会话：新登录完成全部认证后撤销旧令牌，并等待旧投屏、scrcpy 进程和 ADB 转发清理完成后返回。启用 2FA 时，仅密码正确还不会接管，需继续完成验证码验证，或通过仍有效的可信浏览器校验。旧投屏页面收到 WebSocket 关闭通知后回到登录页，提示账号已在其他位置登录；未投屏的旧页面在后续 API 请求（包括设备轮询）返回 401 时退出。输错密码或验证码不会踢掉当前会话，同时登录时以最后一次完成全部认证的登录为准。不会执行全局 `adb disconnect`，不会删除设备记录，新登录可直接选择原设备重新投屏。同一浏览器共享 Cookie 的标签页属于同一个会话，不是独立登录；该机制仅适用于单服务实例，不是第三方身份提供商的 SSO。

反向代理必须转发 WebSocket upgrade。来源白名单已移除，不再要求配置域名；密码、2FA、会话鉴权和 `SameSite=Strict` Cookie 仍保留，但不能替代被移除的来源校验这一层跨站请求防护。不要直接将 ADB 或此控制台暴露到公网；远程访问应通过 HTTPS、VPN 或受控网络。开发服务器监听全部 IPv4 网卡，应仅在受信网络使用。

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

- Cookie 登录、退出、新登录接管旧登录、默认 24 小时可配置持久化会话、登录失败限流、HTTP 写操作和 WebSocket 会话鉴权；不限制访问域名。
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

后端测试包含解析、认证、Cookie 时长、会话重启恢复、旧多会话文件迁移、退出持久撤销、过期与改密失效、移除 Origin 限制后的 HTTP/WebSocket 兼容性与会话鉴权、DTO 校验及模拟 ADB 的投屏生命周期。登录接管测试覆盖真实 HTTP/WebSocket 旧连接关闭、旧令牌失效、失败登录不踢人、启动中接管、并发登录以及同设备即时重用；前端测试覆盖被替换通知后的播放器清理、返回登录页、缩放留白与旋转坐标。自动化测试不代表已完成真机编码器、设备旋转和浏览器视频联调。

设备记录测试使用临时 JSON 和模拟 ADB，覆盖去重、失败不入库、型号更新、重启恢复、接口鉴权及删除不触发断开。JSON 通过临时文件写入后重命名替换，仅支持单实例写入，不支持多个服务进程共用 `.data`。首次保存设备时自动创建文件；损坏的记录文件会阻止启动，修复前请先备份，不会被静默覆盖。

本机验收已通过开发代理下的真实登录、Cookie 属性和退出失效检查；不再提供基于 Origin 的跨源拦截。浏览器模拟设备检查覆盖空设备禁用状态、切换设备时丢弃旧截图、快捷键目标设备、桌面与窄屏布局；浏览器生成的 H.264 Annex B 测试帧已通过 JMuxer 播放并通过像素检查。这些模拟检查不包含真实 WebSocket 转发和 scrcpy 编码器。真机截图、投屏、触控与旋转仍需接入授权设备后验收。

scrcpy 为 Genymobile 的独立开源项目，来源为 https://github.com/Genymobile/scrcpy 。随仓库保存的 server 二进制 SHA-256 与上游 v4.0 发布资产一致，核验记录见 [第三方组件说明](docs/third-party.md)。外部分发前仍须核验完整许可证与通知义务。

## 开源协作

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[SUPPORT.md](SUPPORT.md) 和 [架构说明](docs/architecture.md)。项目自身许可证尚待维护者选择；在明确授权前，不应将公开仓库视为已获得开源使用、修改或再分发授权。第三方许可证不覆盖本项目代码，详见 [第三方组件说明](docs/third-party.md)。

自动化测试使用模拟 ADB、TCP 和浏览器媒体帧，不能替代真实 Android 设备验收。当前尚未完成真机截图、scrcpy 编码器、触控和旋转的完整验证。
