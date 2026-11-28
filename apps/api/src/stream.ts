import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  OnModuleDestroy,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import type { RawData, WebSocket } from 'ws';
import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { AdbService, serialPattern } from './adb';
import { AuthGuard, AuthModule, AuthRequest, AuthService } from './auth';
import { settings } from './config';
import { DevicesModule } from './devices';

class StartStreamDto {
  @IsString() @Matches(serialPattern) serial!: string;
  @IsIn(['h264', 'h265']) videoCodec: 'h264' | 'h265' = 'h264';
  @IsInt() @Min(480) @Max(1920) maxSize = settings.streamMaxSize;
  @IsInt() @Min(10) @Max(60) maxFps = settings.streamMaxFps;
  @IsInt() @Min(500_000) @Max(12_000_000) bitRate = settings.streamBitRate;
}

type StreamOptions = Pick<StartStreamDto, 'maxSize' | 'maxFps' | 'bitRate'> &
  Partial<Pick<StartStreamDto, 'videoCodec'>>;

export type TouchAction = 'down' | 'move' | 'up' | 'cancel';
export interface TouchControl {
  action: TouchAction;
  pointerId: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
}
export type ControlKeyName =
  'home' | 'back' | 'recent' | 'wake' | 'sleep' | 'enter' | 'volumeUp' | 'volumeDown';
export interface KeyControl {
  key: ControlKeyName;
}
export interface ScrollControl {
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  horizontal: number;
  vertical: number;
}
export interface ClipboardControl {
  text: string;
  paste: boolean;
}
export type DeviceActionName = 'expandNotifications' | 'rotateDevice';
type ControlMessage =
  | ({ type: 'touch' } & TouchControl)
  | ({ type: 'key' } & KeyControl)
  | ({ type: 'scroll' } & ScrollControl)
  | ({ type: 'clipboard' } & ClipboardControl)
  | { type: 'displayPower'; on: boolean }
  | { type: 'action'; action: DeviceActionName };

const controlKeyCodes: Record<ControlKeyName, number> = {
  home: 3,
  back: 4,
  recent: 187,
  wake: 224,
  sleep: 223,
  enter: 66,
  volumeUp: 24,
  volumeDown: 25,
};

export function encodeTouchControl(event: TouchControl) {
  const actionCode: Record<TouchAction, number> = { down: 0, up: 1, move: 2, cancel: 1 };
  if (!Object.hasOwn(actionCode, event.action)) throw new Error('触控动作无效');
  if (!Number.isSafeInteger(event.pointerId) || event.pointerId < 0) throw new Error('触控指针无效');
  if (![event.x, event.y].every(Number.isInteger) || event.x < 0 || event.y < 0)
    throw new Error('触控坐标无效');
  if (
    ![event.screenWidth, event.screenHeight].every(Number.isInteger) ||
    event.screenWidth < 1 ||
    event.screenHeight < 1 ||
    event.screenWidth > 65535 ||
    event.screenHeight > 65535
  )
    throw new Error('触控画面尺寸无效');
  if (event.x >= event.screenWidth || event.y >= event.screenHeight) throw new Error('触控坐标超出画面');
  const message = Buffer.alloc(32);
  message.writeUInt8(2, 0);
  message.writeUInt8(actionCode[event.action], 1);
  message.writeBigUInt64BE(BigInt(event.pointerId), 2);
  message.writeInt32BE(event.x, 10);
  message.writeInt32BE(event.y, 14);
  message.writeUInt16BE(event.screenWidth, 18);
  message.writeUInt16BE(event.screenHeight, 20);
  message.writeUInt16BE(event.action === 'up' || event.action === 'cancel' ? 0 : 0xffff, 22);
  return message;
}

export function encodeKeyControl(event: KeyControl) {
  if (!Object.hasOwn(controlKeyCodes, event.key)) throw new Error('按键无效');
  const keycode = controlKeyCodes[event.key];
  const down = Buffer.alloc(14);
  down.writeUInt8(0, 0);
  down.writeUInt8(0, 1);
  down.writeInt32BE(keycode, 2);
  const up = Buffer.alloc(14);
  up.writeUInt8(0, 0);
  up.writeUInt8(1, 1);
  up.writeInt32BE(keycode, 2);
  return Buffer.concat([down, up]);
}

function floatToI16FixedPoint(value: number) {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.max(-32768, Math.min(32767, Math.round(clamped * 32767)));
}

export function encodeScrollControl(event: ScrollControl) {
  if (![event.x, event.y].every(Number.isInteger) || event.x < 0 || event.y < 0)
    throw new Error('滚轮坐标无效');
  if (
    ![event.screenWidth, event.screenHeight].every(Number.isInteger) ||
    event.screenWidth < 1 ||
    event.screenHeight < 1 ||
    event.screenWidth > 65535 ||
    event.screenHeight > 65535
  )
    throw new Error('滚轮画面尺寸无效');
  if (event.x >= event.screenWidth || event.y >= event.screenHeight) throw new Error('滚轮坐标超出画面');
  if (!Number.isFinite(event.horizontal) || !Number.isFinite(event.vertical)) throw new Error('滚轮增量无效');
  const message = Buffer.alloc(21);
  message.writeUInt8(3, 0);
  message.writeInt32BE(event.x, 1);
  message.writeInt32BE(event.y, 5);
  message.writeUInt16BE(event.screenWidth, 9);
  message.writeUInt16BE(event.screenHeight, 11);
  message.writeInt16BE(floatToI16FixedPoint(event.horizontal), 13);
  message.writeInt16BE(floatToI16FixedPoint(event.vertical), 15);
  message.writeInt32BE(0, 17);
  return message;
}

export function encodeClipboardControl(event: ClipboardControl) {
  if (typeof event.text !== 'string' || !event.text.length || [...event.text].length > 2000)
    throw new Error('剪贴板文本无效');
  const payload = Buffer.from(event.text, 'utf8');
  if (payload.length > 8192) throw new Error('剪贴板文本过长');
  const header = Buffer.alloc(14);
  header.writeUInt8(9, 0);
  header.writeBigUInt64BE(0n, 1);
  header.writeUInt8(event.paste ? 1 : 0, 9);
  header.writeUInt32BE(payload.length, 10);
  return Buffer.concat([header, payload]);
}

export function encodeDisplayPowerControl(on: boolean) {
  return Buffer.from([10, on ? 1 : 0]);
}

export function encodeDeviceActionControl(action: DeviceActionName) {
  if (action === 'expandNotifications') return Buffer.from([5]);
  if (action === 'rotateDevice') return Buffer.from([11]);
  throw new Error('设备动作无效');
}

function parseControlMessage(data: RawData): ControlMessage | undefined {
  try {
    const buffer = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (item.type === 'touch') {
      const actions: TouchAction[] = ['down', 'move', 'up', 'cancel'];
      if (typeof item.action !== 'string' || !actions.includes(item.action as TouchAction)) return;
      const numbers = ['pointerId', 'x', 'y', 'screenWidth', 'screenHeight'].map((key) => item[key]);
      if (!numbers.every((num) => typeof num === 'number' && Number.isInteger(num))) return;
      return {
        type: 'touch',
        action: item.action as TouchAction,
        pointerId: numbers[0] as number,
        x: numbers[1] as number,
        y: numbers[2] as number,
        screenWidth: numbers[3] as number,
        screenHeight: numbers[4] as number,
      };
    }
    if (item.type === 'key') {
      if (typeof item.key !== 'string' || !Object.hasOwn(controlKeyCodes, item.key)) return;
      return { type: 'key', key: item.key as ControlKeyName };
    }
    if (item.type === 'scroll') {
      const ints = ['x', 'y', 'screenWidth', 'screenHeight'].map((key) => item[key]);
      if (!ints.every((num) => typeof num === 'number' && Number.isInteger(num))) return;
      if (typeof item.horizontal !== 'number' || typeof item.vertical !== 'number') return;
      return {
        type: 'scroll',
        x: ints[0] as number,
        y: ints[1] as number,
        screenWidth: ints[2] as number,
        screenHeight: ints[3] as number,
        horizontal: item.horizontal,
        vertical: item.vertical,
      };
    }
    if (item.type === 'clipboard') {
      if (typeof item.text !== 'string' || !item.text.length) return;
      return { type: 'clipboard', text: item.text, paste: item.paste !== false };
    }
    if (item.type === 'displayPower') {
      if (typeof item.on !== 'boolean') return;
      return { type: 'displayPower', on: item.on };
    }
    if (item.type === 'action') {
      if (item.action !== 'expandNotifications' && item.action !== 'rotateDevice') return;
      return { type: 'action', action: item.action };
    }
    return;
  } catch {
    return;
  }
}

let cachedJarHash: { path: string; size: number; mtimeMs: number; hash: string } | undefined;

function resolveRemoteJarPath(localPath: string, version: string) {
  const safeVersion = version.replace(/[^A-Za-z0-9._-]/g, '_');
  const stats = statSync(localPath);
  if (
    !cachedJarHash ||
    cachedJarHash.path !== localPath ||
    cachedJarHash.size !== stats.size ||
    cachedJarHash.mtimeMs !== stats.mtimeMs
  ) {
    const hash = createHash('sha256').update(readFileSync(localPath)).digest('hex').slice(0, 8);
    cachedJarHash = { path: localPath, size: stats.size, mtimeMs: stats.mtimeMs, hash };
  }
  return `/data/local/tmp/adb-console-server-${safeVersion}-${cachedJarHash.hash}.jar`;
}

const closeCodes: Record<string, { code: number; reason: string }> = {
  'session replaced': { code: 4001, reason: 'session replaced' },
  'viewer too slow': { code: 4002, reason: 'viewer too slow' },
  'scrcpy exited': { code: 4003, reason: 'encoder exited' },
  'scrcpy failed': { code: 4003, reason: 'encoder exited' },
  'control overloaded': { code: 4004, reason: 'control overloaded' },
};

export class StreamSession {
  readonly id = randomUUID();
  readonly clients = new Set<WebSocket>();
  readonly createdAt = Date.now();
  private process: ChildProcess | undefined;
  private tcp: net.Socket | undefined;
  private control: net.Socket | undefined;
  private controlReady = false;
  private readonly activeTouches = new Map<number, TouchControl>();
  private stopped = false;
  private port: number | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private stopPromise: Promise<void> | undefined;
  private attempts = 0;
  private receivedData = false;
  private stderrTail = '';
  private readonly socketId = (randomBytes(4).readUInt32BE(0) & 0x7fffffff || 1)
    .toString(16)
    .padStart(8, '0');
  deviceSize: { width: number; height: number } | undefined;

  constructor(
    readonly serial: string,
    readonly authSessionId: string,
    private readonly adb: AdbService,
    private readonly options: StreamOptions,
    private readonly terminated: () => void = () => {},
  ) {}

  async start() {
    if (!existsSync(settings.scrcpyPath))
      throw new BadRequestException(`找不到 scrcpy-server: ${settings.scrcpyPath}`);
    await this.adb.ready(this.serial);
    this.deviceSize = await this.adb.size(this.serial);
    try {
      if (this.stopped) throw new BadRequestException('投屏启动已取消');
      const remoteJar = resolveRemoteJarPath(settings.scrcpyPath, settings.scrcpyVersion);
      let cached = false;
      try {
        const probe = await this.adb.run(
          ['shell', 'test', '-s', remoteJar, '&&', 'echo', 'ok'],
          this.serial,
          5_000,
        );
        cached = probe?.stdout?.toString().trim() === 'ok';
      } catch {
        cached = false;
      }
      if (this.stopped) throw new BadRequestException('投屏启动已取消');
      if (!cached) {
        await this.adb.run(['push', settings.scrcpyPath, remoteJar], this.serial, 30_000);
        if (this.stopped) throw new BadRequestException('投屏启动已取消');
      }
      const port = await this.adb.text(
        ['forward', 'tcp:0', `localabstract:scrcpy_${this.socketId}`],
        this.serial,
      );
      const forwardedPort = Number(port);
      if (!Number.isInteger(forwardedPort) || forwardedPort < 1 || forwardedPort > 65535)
        throw new BadRequestException('ADB 未返回有效转发端口');
      this.port = forwardedPort;
      if (this.stopped) throw new BadRequestException('投屏启动已取消');
      this.process = this.adb.spawn(this.serial, [
        'shell',
        `CLASSPATH=${remoteJar}`,
        'app_process',
        '/',
        'com.genymobile.scrcpy.Server',
        settings.scrcpyVersion,
        'tunnel_forward=true',
        'audio=false',
        'control=true',
        'clipboard_autosync=false',
        'cleanup=false',
        'raw_stream=true',
        'send_dummy_byte=true',
        `scid=${this.socketId}`,
        `max_size=${this.options.maxSize}`,
        `max_fps=${this.options.maxFps}`,
        `video_bit_rate=${this.options.bitRate}`,
        `video_codec=${this.options.videoCodec ?? 'h264'}`,
      ]);
      this.process.stdout?.resume();
      this.process.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4096);
      });
      this.process.once('error', (error) => {
        if (!this.stopped) {
          console.warn(`[stream] scrcpy spawn error (${this.serial}): ${error.message.slice(0, 200)}`);
        }
        void this.stop('scrcpy failed');
      });
      this.process.once('exit', (code, signal) => {
        if (!this.stopped) {
          const detail = this.stderrTail.replace(/\s+/g, ' ').trim().slice(-300);
          console.warn(
            `[stream] scrcpy exited (${this.serial}, code=${code ?? 'null'}, signal=${signal ?? 'null'})${detail ? `: ${detail}` : ''}`,
          );
          void this.stop('scrcpy exited');
        }
      });
      this.scheduleIdleStop();
    } catch (error) {
      await this.stop('startup failed');
      await this.cleanupForward();
      throw error;
    }
  }

  attach(socket: WebSocket) {
    if (this.stopped) return socket.close(1008, 'session stopped');
    if (this.clients.size || this.receivedData) return socket.close(1008, 'restart stream for a new decoder');
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.clients.add(socket);
    const detach = () => {
      this.clients.delete(socket);
      if (!this.clients.size) void this.stop('viewer disconnected');
    };
    socket.on('close', detach);
    socket.on('error', detach);
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    this.heartbeatTimer = setInterval(() => {
      if (!alive || socket.readyState !== 1) {
        void this.stop('viewer heartbeat timed out');
        return;
      }
      alive = false;
      socket.ping();
    }, 15_000);
    this.heartbeatTimer.unref();
    socket.on('message', (data, isBinary) => {
      const event = isBinary ? undefined : parseControlMessage(data);
      if (!event) {
        void this.stop('invalid control message');
        return;
      }
      this.sendControl(event);
    });
    if (!this.tcp) void this.connectVideo();
  }

  summary() {
    return {
      id: this.id,
      serial: this.serial,
      deviceSize: this.deviceSize,
      createdAt: this.createdAt,
      clientCount: this.clients.size,
      started: !this.stopped,
      options: { ...this.options },
    };
  }

  async stop(reason: string) {
    if (this.stopped) return this.stopPromise;
    this.stopped = true;
    this.terminated();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const closeInfo = closeCodes[reason];
    for (const client of this.clients) {
      if (closeInfo && client.readyState === 1 && typeof client.close === 'function') {
        client.close(closeInfo.code, closeInfo.reason);
        const timer = setTimeout(() => client.terminate(), 1000);
        timer.unref();
        client.once('close', () => clearTimeout(timer));
      } else client.terminate();
    }
    this.clients.clear();
    this.tcp?.destroy();
    this.tcp = undefined;
    const control = this.control;
    if (this.activeTouches.size && this.controlReady && control?.writable) {
      const releases = [...this.activeTouches.values()].map((touch) =>
        encodeTouchControl({ ...touch, action: 'up' }),
      );
      control.end(Buffer.concat(releases));
      control.setTimeout(1000, () => control.destroy());
    } else this.control?.destroy();
    this.activeTouches.clear();
    this.controlReady = false;
    this.control = undefined;
    this.process?.kill();
    this.process = undefined;
    this.stopPromise = this.cleanupForward();
    return this.stopPromise;
  }

  private scheduleIdleStop() {
    this.idleTimer = setTimeout(() => {
      void this.stop('no viewer');
    }, 30_000);
    this.idleTimer.unref();
  }

  private async connectVideo() {
    if (!this.port || this.stopped || this.tcp) return;
    this.attempts += 1;
    const socket = net.connect(this.port, '127.0.0.1');
    this.tcp = socket;
    socket.setNoDelay(true);
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let handshake = false;
    socket.on('data', (chunk: Buffer) => {
      if (!handshake) {
        if (chunk[0] !== 0) {
          void this.stop('invalid video handshake');
          return;
        }
        handshake = true;
        this.connectControl();
        chunk = chunk.subarray(1);
      }
      if (!chunk.length) return;
      socket.setTimeout(0);
      this.receivedData = true;
      this.broadcast(chunk);
    });
    socket.once('close', () => {
      this.tcp = undefined;
      if (this.stopped) return;
      if (handshake || this.receivedData || this.attempts >= 30) {
        void this.stop('video disconnected');
        return;
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.connectVideo();
      }, 250);
    });
  }

  private connectControl() {
    if (!this.port || this.stopped || this.control) return;
    const control = net.connect(this.port, '127.0.0.1', () => {
      if (this.stopped) {
        control.destroy();
        return;
      }
      this.controlReady = true;
      for (const client of this.clients)
        if (client.readyState === 1) client.send(JSON.stringify({ type: 'control', ready: true }));
    });
    this.control = control;
    control.setNoDelay(true);
    control.resume();
    control.once('error', () => control.destroy());
    control.once('close', () => {
      if (this.control === control) this.control = undefined;
      if (!this.stopped) void this.stop('control disconnected');
    });
  }

  private sendControl(event: ControlMessage) {
    if (
      !this.controlReady ||
      !this.control ||
      this.control.destroyed ||
      !this.control.writable ||
      this.stopped
    )
      return;
    try {
      let message: Buffer;
      if (event.type === 'touch') {
        message = encodeTouchControl(event);
        if (event.action === 'down') {
          if (this.activeTouches.has(event.pointerId) || this.activeTouches.size >= 10) return;
        } else if (!this.activeTouches.has(event.pointerId)) {
          return;
        }
      } else if (event.type === 'key') {
        message = encodeKeyControl(event);
      } else if (event.type === 'scroll') {
        message = encodeScrollControl(event);
      } else if (event.type === 'clipboard') {
        message = encodeClipboardControl(event);
      } else if (event.type === 'displayPower') {
        message = encodeDisplayPowerControl(event.on);
      } else {
        message = encodeDeviceActionControl(event.action);
      }
      if (this.control.writableLength > 64 * 1024) {
        void this.stop('control overloaded');
        return;
      }
      this.control.write(message);
      if (event.type === 'touch') {
        if (event.action === 'up' || event.action === 'cancel') this.activeTouches.delete(event.pointerId);
        else this.activeTouches.set(event.pointerId, event);
      }
    } catch {
      void this.stop('invalid control');
    }
  }

  private broadcast(chunk: Buffer) {
    const bufferLimit = Math.max(256 * 1024, (this.options.bitRate / 8) * 2);
    for (const client of this.clients) {
      if (client.readyState !== 1) continue;
      if (client.bufferedAmount + chunk.length > bufferLimit) {
        void this.stop('viewer too slow');
        return;
      }
      client.send(chunk, { binary: true });
    }
  }

  private async cleanupForward() {
    if (this.port) {
      try {
        await this.adb.run(['forward', '--remove', `tcp:${this.port}`], this.serial);
      } catch {}
      this.port = undefined;
    }
  }
}

@Injectable()
export class StreamService implements OnModuleDestroy {
  private readonly sessions = new Map<string, StreamSession>();
  private pending: Promise<unknown> = Promise.resolve();
  private shuttingDown = false;
  constructor(
    private readonly adb: AdbService,
    private readonly auth: AuthService,
  ) {}

  async start(
    serial: string,
    authSessionId: string,
    options: StreamOptions = {
      maxSize: settings.streamMaxSize,
      maxFps: settings.streamMaxFps,
      bitRate: settings.streamBitRate,
    },
  ) {
    const operation = this.pending.then(async () => {
      if (this.shuttingDown) throw new BadRequestException('服务正在关闭');
      if (!this.auth.isActive(authSessionId)) throw new UnauthorizedException('登录已失效，请重新登录');
      for (const session of this.sessions.values()) {
        if (session.serial === serial && session.authSessionId !== authSessionId)
          throw new ConflictException('设备正在被其他会话投屏');
      }
      const otherSessions = [...this.sessions.values()].filter(
        (session) => session.authSessionId !== authSessionId,
      );
      if (otherSessions.length >= settings.streamMaxSessions)
        throw new ConflictException('投屏数量已达上限，请停止其他投屏后重试');
      for (const session of this.sessions.values())
        if (session.authSessionId === authSessionId) await this.stop(session.id, 'replaced');
      if (!this.auth.isActive(authSessionId)) throw new UnauthorizedException('登录已失效，请重新登录');
      const session = new StreamSession(
        serial,
        authSessionId,
        this.adb,
        {
          maxSize: Math.min(options.maxSize, settings.streamMaxSize),
          maxFps: Math.min(options.maxFps, settings.streamMaxFps),
          bitRate: Math.min(options.bitRate, settings.streamBitRate),
          videoCodec: options.videoCodec ?? 'h264',
        },
        () => this.sessions.delete(session.id),
      );
      this.sessions.set(session.id, session);
      try {
        await session.start();
        if (!this.auth.isActive(authSessionId)) throw new UnauthorizedException('登录已失效，请重新登录');
        return session;
      } catch (error) {
        await this.stop(session.id, 'startup failed');
        throw error;
      }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  get(id: string) {
    return this.sessions.get(id);
  }
  list(authSessionId: string) {
    return [...this.sessions.values()]
      .filter((item) => item.authSessionId === authSessionId)
      .map((item) => item.summary());
  }
  async stop(id: string, reason = 'manual') {
    const session = this.sessions.get(id);
    if (!session) return false;
    await session.stop(reason);
    this.sessions.delete(id);
    return true;
  }
  stopForAuth(authSessionId: string) {
    const sessions = [...this.sessions.values()].filter((session) => session.authSessionId === authSessionId);
    const operation = Promise.all([
      this.pending,
      ...sessions.map((session) => this.stop(session.id, 'logout')),
    ]).then(async () => {
      const remaining = [...this.sessions.values()].filter(
        (session) => session.authSessionId === authSessionId,
      );
      await Promise.all(remaining.map((session) => this.stop(session.id, 'logout')));
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  stopInactive() {
    return this.stopSessions(
      [...this.sessions.values()].filter((session) => !this.auth.isActive(session.authSessionId)),
      'session replaced',
    );
  }
  private async stopSessions(sessions: StreamSession[], reason: string) {
    const operation = Promise.all([
      this.pending,
      ...sessions.map((session) => this.stop(session.id, reason)),
    ]);
    this.pending = operation.catch(() => {});
    await operation;
  }
  async onModuleDestroy() {
    this.shuttingDown = true;
    await this.pending;
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id, 'shutdown')));
  }
}

@Controller('streams')
@UseGuards(AuthGuard)
class StreamController {
  constructor(private readonly streams: StreamService) {}
  @Get('config') config() {
    return {
      maxSize: settings.streamMaxSize,
      maxFps: settings.streamMaxFps,
      bitRate: settings.streamBitRate,
    };
  }
  @Post() async start(@Body() body: StartStreamDto, @Req() request: AuthRequest) {
    const session = await this.streams.start(body.serial, request.session.id, body);
    return session.summary();
  }
  @Get() list(@Req() request: AuthRequest) {
    return this.streams.list(request.session.id);
  }
  @Delete(':id') async stop(@Param('id') id: string, @Req() request: AuthRequest) {
    const session = this.streams.get(id);
    if (session && session.authSessionId !== request.session.id)
      throw new ForbiddenException('无权操作该会话');
    return { ok: await this.streams.stop(id) };
  }
}

@Module({
  imports: [AuthModule, DevicesModule],
  providers: [StreamService],
  controllers: [StreamController],
  exports: [StreamService],
})
export class StreamModule {}
