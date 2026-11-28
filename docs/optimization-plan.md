# 后续优化方案

本文档基于当前 `adb-desk` (`v1.0.2`) 代码现状与构建/测试实测结果整理，面向低算力宿主（如 R2S ARM64）、弱网内网穿透（FRP + Nginx）及移动浏览器使用场景，按优先级列出可落地的后续优化方案。

## 优化进展记录

截至当前版本，以下项目已完成落地并通过 `npm run check` 及浏览器回归验证：

- **UI 交互与视觉体验重构**：修复 Tooltip 穿透遮挡弹窗/抽屉、添加设备关闭后重置脏状态、弹窗切抽屉过渡重叠、全屏受限环境降级；升级工作台/登录页/安全设置页视觉层级与语义图标；移动端收敛为单滚动容器并放大触控热区；操作日志新增错误分级与一键清空。
- **P0 #1 认证热路径性能与 SQLite 读连接复用**：`AuthService` / `TwoFactorService` 缓存派生 HMAC 密钥并移出循环计算，`StorageService.read()` 支持嵌套读复用同一连接，API 测试总耗时由 `14.2s` 降至 `~5.8s`（`-59%`）。
- **P0 #2 前端 TDesign 按需打包与静态资源长缓存**：`main.ts` 与消息提示改为子路径按需导入并拆包，主包无 `500 kB` 告警；JS 总量由 `1,630 kB`（gzip `433 kB`）降至 `617 kB`（gzip `177 kB`，`-59%`），CSS 总量由 `466 kB`（gzip `55.4 kB`）降至 `136 kB`（gzip `17.6 kB`，`-68%`）；Fastify 静态 `/assets/*` 增加 `immutable` 长缓存、`index.html` 设为 `no-cache`。
- **P1 #3 跳过重复推送 `scrcpy-server`**：远程路径包含版本与 SHA-256 短摘要，设备已有匹配文件时直接跳过 `adb push`。
- **P1 #4 前端画质/码率档位预设**：工具栏新增「省流 / 均衡 / 高清」画质选择器并透传至 `StartStreamDto`，后端新增 `GET /api/streams/config` 暴露服务端上限，严格夹紧部署配额。
- **P1 #5 复用 scrcpy control 通道**：支持多指触控（最多 10 并发指针、断连统一释放）、鼠标滚轮（`INJECT_SCROLL_EVENT`）、投屏态毫秒级按键（`INJECT_KEYCODE`）、中文/UTF-8 剪贴板粘贴输入（`SET_CLIPBOARD`）、息屏投屏（`SET_DISPLAY_POWER`）、展开通知栏（`EXPAND_NOTIFICATION_PANEL`）与旋转屏幕（`ROTATE_DEVICE`）。
- **P1 #6 截图缩放与并发去重 + 图像模式及时刷新**：后端新增 `?maxSize` 缩放参数、设备尺寸响应头与 singleflight 去重；前端兼容图像模式默认请求 `?maxSize=960` 缩放图并按原始物理分辨率头映射坐标，操作后 200ms 提前刷新、切回前台立即拉帧。
- **P1 #7 Android 11+ 网页无线配对 & 已装应用列表**：新增 `POST /api/devices/pair` 及「直接连接 / 无线配对」双标签页；新增 `GET /api/devices/:serial/apps` 与前端可搜索已装第三方应用选择器。
- **P0/P2 压缩、异步加密、可观测性与安全加固**：Fastify 零依赖接入 `node:zlib` Brotli/Gzip 响应压缩；HTTP 登录/注册/改密/2FA 安全操作全面切换至异步 `crypto.scrypt`（避免阻塞视频转发）；保留 `scrcpy-server` 末尾 4 KiB `stderr` 异常日志与 ADB 初始化失败日志；新增 `4002/4003/4004` 自定义 WS Close Code 与前端精准提示；启用严格 Helmet CSP（保留局域网 HTTP 兼容）；新增可选 `TRUST_PROXY` 配置；新增数据库管理员在线修改密码（`POST /api/auth/password` + 安全设置界面）；`socketId` 改为位掩码生成；`theme-color` 统一为 `#087e70`。

---

## 当前基线（优化前参考）

- **质量检查**：`npm run check` 全通过（ESLint 0 warning、Prettier 通过、后端 35 通过 / 1 跳过、前端 101 用例全通过）。
- **前端首屏构建体积**：
  - `apps/web/dist/assets/index-*.js`：`1,470.60 kB`（gzip `395.41 kB`，超出 Vite 500 kB chunk 告警阈值）
  - `apps/web/dist/assets/index-*.css`：`459.90 kB`（gzip `54.07 kB`）
- **后端容器资源预算**：`256 MiB` 内存上限（`--max-old-space-size=128`），单进程承载 HTTP、SQLite、ADB 子进程、sharp 截图转码与 scrcpy WebSocket 转发。

---

## P0：高收益性能与体积优化

### 1. 消除认证热路径的同步 `scryptSync` 与重复开关 SQLite 连接

- **现状与定位**
  - `apps/api/src/auth.ts`：`AuthGuard` 每次校验会话都会调用 `AuthService.find(token)` → `mode()`（开/关 SQLite）→ `store.read()`（开/关 SQLite）→ `hash()` → `sessionKey()`（再次查库并同步执行 `scryptSync`）。
  - `apps/api/src/two-factor.ts`：`status()` 和 `isTrusted()` 在数组 `.find()` / `.some()` 回调内重复调用 `this.hash()`，每条可信浏览器记录都会触发一次读库与同步 `scryptSync`。
  - `apps/api/src/storage.ts`：每次 `read()` 都会新建 `DatabaseSync`、执行 `PRAGMA` 后再关闭。
- **影响**
  - `scryptSync` 在单线程主事件循环中同步消耗大量 CPU（在 ARM64 路由器上单次可达 100–250ms+），会直接阻塞正在转发的 WebSocket 视频帧与触控消息，引发画面抖动或背压断流。
- **实施方案**
  1. **缓存派生 HMAC 密钥**：在 `AuthService` 和 `TwoFactorService` 中按当前密码来源（环境变量密码或数据库 `passwordHash`）缓存 32 字节 HMAC key，注册或改密时失效重建。
  2. **循环外预计算摘要**：`TwoFactorService.status()` 与 `isTrusted()` 先计算一次目标 token 摘要后再遍历匹配。
  3. **密码校验异步化**：将登录、注册与安全设置的密码校验改为异步 `crypto.scrypt`（`promisify`），避免密码请求或暴力尝试阻塞视频转发。
  4. **复用 SQLite 长连接**：在单进程独占边界下维护长连接并配合 `onModuleDestroy` 优雅关闭，同时保留同步事务语义和 `synchronous = FULL`。
- **验收标准**
  - 已登录态高频请求 `/api/auth/session`、`/api/devices` 不再触发 `scryptSync`。
  - 压测连续并发认证请求时，活跃 WebSocket 视频流转发延迟无明显毛刺。
  - 现有认证、2FA、存储事务与回滚单元测试全部通过。

### 2. 前端 TDesign 按需引入与静态资源传输优化

- **现状与定位**
  - `apps/web/src/main.ts` 全量引入了 `tdesign-vue-next` 与 `tdesign-vue-next/es/style/index.css`，但项目实际仅使用 `Button`、`Select`、`Tooltip`、`Input`、`Dialog`、`Drawer`、`Loading`、`MessagePlugin` 等少量组件。
  - `apps/api/src/main.ts` 托管静态资源未针对带哈希的 `/assets/*` 配置长缓存与响应压缩。
- **实施方案**
  1. 接入 `unplugin-vue-components`（`TDesignResolver`）或手动显式注册所用组件与样式，移除全量导入。
  2. 在 `apps/web/vite.config.ts` 中合理拆分 `manualChunks`（如分离 `vue`、`jmuxer` 与 UI 组件），消除 500 kB chunk 告警。
  3. 在 Fastify 静态资源层为 `/assets/*` 配置 `Cache-Control: public, max-age=31536000, immutable`（`index.html` 保持 `no-cache`），并为文本类资源启用 `@fastify/compress`（跳过 WebP 图片与 WebSocket）。
- **验收标准**
  - 首屏主包 JS 与 CSS 体积（gzip 后）显著下降（目标缩减 60% 以上），Vite 构建无 chunk 体积告警。
  - 全部前端单元测试及页面交互（登录、工作台、弹框、抽屉、2FA）正常。

---

## P1：投屏延迟、交互体验与核心能力增强

### 3. 按版本/摘要跳过 `scrcpy-server` 重复推送

- **现状与定位**
  - `apps/api/src/stream.ts` 每次 `start()` 均执行 `adb push` 到 `/data/local/tmp/adb-console-server.jar`。
- **实施方案**
  - 启动时计算本地 `vendor/scrcpy-server-v4.0` 的短 SHA-256 摘要，推送路径改为 `/data/local/tmp/adb-console-server-${version}-${hash8}.jar`；推送前先检测目标文件与字节数是否已匹配，匹配则跳过 `adb push`。
- **验收标准**
  - 同一设备二次启动投屏、重连或切换 H.264/H.265 时不再重复传输 jar 包，启动耗时明显缩短。

### 4. 开放前端画质/帧率/码率预设与参数透传

- **现状与定位**
  - 后端 `StartStreamDto`（`apps/api/src/stream.ts`）已支持并限制 `maxSize`、`maxFps`、`bitRate`，但前端 `startStream()`（`apps/web/src/api.ts`）尚未传入这些参数。
- **实施方案**
  - 新增后端配置下发（或在接口返回服务端允许的最大档位），前端工具栏提供“省流 / 均衡 / 高清”等预设档位（可选记住用户本地偏好），按需传给 `POST /api/streams`，服务端继续强制 `Math.min(requested, serverLimit)`。
- **验收标准**
  - 弱网下可手动切至低码率/低分辨率档位并生效，客户端无法突破服务端环境变量上限。

### 5. 复用 scrcpy control 通道提升按键、输入与多指手势能力

- **现状与定位**
  - `apps/api/src/devices.ts` 每次按键/点击/输入都会先执行 `adb devices -l`（`adb.ready()`），再拉起 `adb shell input ...` 子进程，操作延迟高。
  - `POST /api/devices/text` 受限于 `adb shell input text`，仅支持有限 ASCII 字符，不支持中文与粘贴。
  - `apps/api/src/stream.ts` 中 `activeTouch` 仅允许单指触控，不支持双指缩放。
- **实施方案**
  1. **多指触控**：将 `activeTouch` 重构为 `Map<number, TouchControl>`（限制最大并发指点数，如 5–10），前端 `ScreenTouch` 同步支持多 `pointerId` 跟踪与断连统一抬起清理。
  2. **控制通道按键与滚轮**：投屏活跃时，通过 control TCP 通道直接编码发送 scrcpy `INJECT_KEYCODE` 和 `INJECT_SCROLL_EVENT`，未投屏时回退原有 ADB HTTP 接口。
  3. **中文文本与剪贴板注入**：通过 scrcpy `SET_CLIPBOARD`（带 `paste=true`）支持中文、换行及完整 UTF-8 文本输入。
  4. **设备在线状态轻量缓存**：引入短 TTL 缓存或 `adb track-devices` 维护设备状态，减少高频控制命令前重复执行 `adb devices -l`。
- **验收标准**
  - 投屏状态下返回/主页/音量按键响应显著加快；支持中文发送与双指捏合缩放；异常断流时所有活跃指针都能正确发送 `up` 释放。

### 6. 兼容图像模式的内存安全与交互刷新优化

- **现状与定位**
  - `apps/api/src/adb.ts` `screenshot()` 直接抓取全分辨率 PNG 并用 `sharp` 转 WebP，无尺寸限制与并发合并；在 `256 MiB` 内存限制下，多标签页并发请求高分辨率设备存在 OOM 风险。
  - `apps/web/src/features/stream/useStream.ts` 固定每 1 秒拉取下一帧，操作后需等待下一周期才可见结果。
- **实施方案**
  1. 截图接口支持可选缩放参数（如 `?maxSize=960`，限制上限与合法范围），图像模式默认按预览尺寸请求缩放图，手动“下载截图”仍保持原图。
  2. 服务端按 `serial + maxSize` 做 in-flight 请求合并（singleflight）及并发保护，防止多标签页压垮容器内存。
  3. 前端在图像模式完成 `tap` / `swipe` / 按键后主动触发一次延迟约 150–250ms 的提前刷新；监听 `visibilitychange` 回到前台时立刻恢复拉帧。
- **验收标准**
  - 兼容图像模式下的带宽与内存峰值明显降低，点击/滑动后的视觉反馈更及时。

### 7. 支持 Android 11+ 无线调试配对（`adb pair`）

- **现状与定位**
  - 当前仅提供 `adb connect host:port`，Android 11+ 无线调试首次连接仍需借助外部命令行配对。
- **实施方案**
  - 后端新增 `POST /api/devices/pair`（严格校验 `host:port` 与 6 位数字配对码，参数化执行 `adb pair` 并设置合理超时）。
  - 前端 `DeviceConnectDialog.vue` 增加“无线配对”折叠区或标签页，配对成功后可引导直接填写连接端口完成连接。
- **验收标准**
  - 用户可在浏览器内完成“无线配对 → 无线连接”全流程，异常配对码与超时均有清晰提示。

### 8. 评估 WebCodecs 低延迟视频解码路径（中长期）

- **现状与定位**
  - 当前视频播放依赖 `JMuxer`（MSE / fMP4），存在一定缓冲延迟，且构建时产生 Node `stream` 模块 externalized 提示。
- **实施方案**
  - 在支持 `VideoDecoder` 的现代浏览器中试点 H.264/H.265 `WebCodecs` + `<canvas>` 解码器作为可选低延迟模式，保留 `JMuxer`（适配 iOS `ManagedMediaSource` 等）与“兼容图像”作为完整降级链路。

---

## P2：安全加固、可观测性与工程可维护性

### 9. 增强服务端可观测性与精准断线反馈

- **现状与定位**
  - `apps/api/src/adb.ts` `startServer()` 的 `catch` 吞掉了原始异常；`apps/api/src/stream.ts` 丢弃了 `scrcpy-server` 的 `stderr`；除 `4001`（会话替换）外，其余停止原因均直接 `client.terminate()`，前端无法区分断线原因。
- **实施方案**
  1. 环形缓存 `scrcpy-server` 末尾 4 KiB `stderr`，仅在异常退出时输出脱敏诊断日志；`AdbService.startServer()` 记录脱敏失败阶段与退出码。
  2. 定义明确的自定义 WebSocket Close Code（例如 `4002` 网络积压过慢、`4003` 设备编码器异常退出、`4004` 控制通道过载），前端据此展示针对性建议（如降低码率、切换 H.264 或兼容图像）。

### 10. 安全策略与单管理员账户能力完善

- **开启 CSP**：在 `apps/api/src/main.ts` 为 `@fastify/helmet` 配置严格 `contentSecurityPolicy`（允许 `'self'`、`blob:`、`data:` 媒体/二维码及 `ws:`/`wss:` 连接），替代当前的 `contentSecurityPolicy: false`。
- **可选代理 IP 信任**：增加可选配置（如 `TRUST_PROXY=false|loopback|<cidr>`），使部署在 Nginx 后的实例可按真实客户端 IP 计数登录失败限流，避免外部扫描导致所有来源共享 `127.0.0.1` 限流桶而锁死管理员。
- **在线修改管理员密码**：在 `SecurityDialog.vue` 和 `AuthController` 中补充修改数据库管理员密码的能力（校验旧密码 + 2FA，完成后撤销现有会话与可信浏览器令牌，与现有密码变更策略一致）。
- **注册密码强度提示与校验**：在首次注册界面提供密码强度提示，对齐 `SECURITY.md` 的建议（如提示建议 12 位以上，并评估最小长度校验）。

### 11. 代码细节与工程发布流完善

- **清理 `socketId` 生成逻辑**：将 `apps/api/src/stream.ts` 中基于 UUID 字符串替换的 `socketId` 改为位掩码生成：`(randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, '0')`，意图更直观。
- **统一主题元信息**：将 `apps/web/index.html` 的 `<meta name="theme-color" content="#11263d" />` 调整为与界面主色 `--accent: #087e70` 一致。
- **补充项目许可证与自动化发布**：确定并添加根 `LICENSE` 文件；在 `.github/workflows/` 中增加基于 Git Tag 的多架构（`linux/amd64`、`linux/arm64`）Docker 镜像构建与发布工作流。

---

## 三、分阶段实施路线图

| 阶段                           | 包含项目                                                                                                         | 预期收益                                                  | 改动风险                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| **第一阶段（快赢优化）**       | #1 认证密钥缓存与 SQLite 连接复用、#2 TDesign 按需引入与静态缓存、#3 跳过重复 push `scrcpy-server`               | CPU 占用与主线程阻塞大幅下降，首屏体积缩减 60%+，开流提速 | 低，边界清晰，现有单测可直接护航                           |
| **第二阶段（体验跃升）**       | #4 前端画质档位、#6 图像模式缩放与即时刷新、#7 Android 11+ 无线配对、#9 精准断线提示与 `scrcpy stderr` 诊断      | 弱网可控性显著增强，真机排障有据可查，移动接入更顺畅      | 中，需补齐前后端单测与真机回归                             |
| **第三阶段（能力拓展与加固）** | #5 control 通道按键/中文剪贴板/多指触控、#10 CSP / `TRUST_PROXY` / 在线改密、#8 WebCodecs 评估、#11 细节与发布流 | 操控延迟与输入能力质变，公网部署安全性更完备              | 中高，涉及 scrcpy 二进制协议与安全边界变更，需真机充分验收 |
