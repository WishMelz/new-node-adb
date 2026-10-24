import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, OnModuleDestroy, Param, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import type { RawData, WebSocket } from 'ws';
import { IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { AdbService, serialPattern } from './adb';
import { AuthGuard, AuthModule, AuthRequest } from './auth';
import { settings } from './config';
import { DevicesModule } from './devices';

class StartStreamDto {
  @IsString() @Matches(serialPattern) serial!: string;
  @IsInt() @Min(480) @Max(1920) maxSize = 1280;
  @IsInt() @Min(10) @Max(60) maxFps = 30;
  @IsInt() @Min(500_000) @Max(12_000_000) bitRate = 4_000_000;
}

type StreamOptions = Pick<StartStreamDto, 'maxSize' | 'maxFps' | 'bitRate'>;

export type TouchAction = 'down' | 'move' | 'up' | 'cancel';
export interface TouchControl {
  action: TouchAction;
  pointerId: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
}

export function encodeTouchControl(event: TouchControl) {
  const actionCode: Record<TouchAction, number> = { down: 0, up: 1, move: 2, cancel: 1 };
  if (!Object.hasOwn(actionCode, event.action)) throw new Error('触控动作无效');
  if (!Number.isSafeInteger(event.pointerId) || event.pointerId < 0) throw new Error('触控指针无效');
  if (![event.x, event.y].every(Number.isInteger) || event.x < 0 || event.y < 0) throw new Error('触控坐标无效');
  if (![event.screenWidth, event.screenHeight].every(Number.isInteger) || event.screenWidth < 1 || event.screenHeight < 1 || event.screenWidth > 65535 || event.screenHeight > 65535) throw new Error('触控画面尺寸无效');
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

function parseTouchControl(data: RawData): TouchControl | undefined {
  try {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    const actions: TouchAction[] = ['down', 'move', 'up', 'cancel'];
    if (item.type !== 'touch' || typeof item.action !== 'string' || !actions.includes(item.action as TouchAction)) return;
    const numbers = ['pointerId', 'x', 'y', 'screenWidth', 'screenHeight'].map(key => item[key]);
    if (!numbers.every(value => typeof value === 'number' && Number.isInteger(value))) return;
    return {
      action: item.action as TouchAction,
      pointerId: numbers[0] as number,
      x: numbers[1] as number,
      y: numbers[2] as number,
      screenWidth: numbers[3] as number,
      screenHeight: numbers[4] as number,
    };
  } catch { return; }
}

export class StreamSession {
  readonly id = randomUUID();
  readonly clients = new Set<WebSocket>();
  readonly createdAt = Date.now();
  private process: ChildProcess | undefined;
  private tcp: net.Socket | undefined;
  private control: net.Socket | undefined;
  private controlReady = false;
  private activeTouch: TouchControl | undefined;
  private stopped = false;
  private port: number | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private stopPromise: Promise<void> | undefined;
  private attempts = 0;
  private receivedData = false;
  private readonly socketId = this.id.replaceAll('-', '').slice(0, 8).replace(/^[89a-f]/, '1');
  deviceSize: { width: number; height: number } | undefined;

  constructor(
    readonly serial: string,
    readonly authSessionId: string,
    private readonly adb: AdbService,
    private readonly options: StreamOptions,
    private readonly terminated: () => void = () => {},
  ) {}

  async start() {
    if (!existsSync(settings.scrcpyPath)) throw new BadRequestException(`找不到 scrcpy-server: ${settings.scrcpyPath}`);
    await this.adb.ready(this.serial);
    this.deviceSize = await this.adb.size(this.serial);
    try {
      await this.adb.run(['push', settings.scrcpyPath, '/data/local/tmp/adb-console-server.jar'], this.serial, 30_000);
      const port = await this.adb.text(['forward', 'tcp:0', `localabstract:scrcpy_${this.socketId}`], this.serial);
      this.port = Number(port);
      if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new BadRequestException('ADB 未返回有效转发端口');
      this.process = this.adb.spawn(this.serial, [
        'shell', `CLASSPATH=/data/local/tmp/adb-console-server.jar`, 'app_process', '/',
        'com.genymobile.scrcpy.Server', settings.scrcpyVersion, 'tunnel_forward=true', 'audio=false',
        'control=true', 'clipboard_autosync=false', 'cleanup=false', 'raw_stream=true', 'send_dummy_byte=true', `scid=${this.socketId}`, `max_size=${this.options.maxSize}`,
        `max_fps=${this.options.maxFps}`, `video_bit_rate=${this.options.bitRate}`, 'video_codec=h264',
      ]);
      this.process.stdout?.resume();
      this.process.stderr?.resume();
      this.process.once('error', () => { void this.stop('scrcpy failed'); });
      this.process.once('exit', () => { if (!this.stopped) void this.stop('scrcpy exited'); });
      this.scheduleIdleStop();
    } catch (error) {
      await this.stop('startup failed');
      throw error;
    }
  }

  attach(socket: WebSocket) {
    if (this.stopped) return socket.close(1008, 'session stopped');
    if (this.clients.size || this.receivedData) return socket.close(1008, 'restart stream for a new decoder');
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.clients.add(socket);
    const detach = () => { this.clients.delete(socket); if (!this.clients.size) void this.stop('viewer disconnected'); };
    socket.on('close', detach);
    socket.on('error', detach);
    socket.on('message', (data, isBinary) => {
      const event = isBinary ? undefined : parseTouchControl(data);
      if (!event) { void this.stop('invalid control message'); return; }
      this.sendTouch(event);
    });
    if (!this.tcp) void this.connectVideo();
  }

  summary() {
    return { id: this.id, serial: this.serial, deviceSize: this.deviceSize, createdAt: this.createdAt, clientCount: this.clients.size, started: !this.stopped };
  }

  async stop(reason: string) {
    if (this.stopped) return this.stopPromise;
    this.stopped = true;
    this.terminated();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    this.tcp?.destroy();
    this.tcp = undefined;
    if (this.activeTouch && this.controlReady && this.control?.writable) {
      this.control.end(encodeTouchControl({ ...this.activeTouch, action: 'up' }));
      this.control.setTimeout(1000, () => this.control?.destroy());
    } else this.control?.destroy();
    this.activeTouch = undefined;
    this.controlReady = false;
    this.control = undefined;
    this.process?.kill();
    this.process = undefined;
    this.stopPromise = this.cleanupForward();
    return this.stopPromise;
  }

  private scheduleIdleStop() {
    this.idleTimer = setTimeout(() => { void this.stop('no viewer'); }, 30_000);
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
        if (chunk[0] !== 0) { void this.stop('invalid video handshake'); return; }
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
      if (handshake || this.receivedData || this.attempts >= 30) { void this.stop('video disconnected'); return; }
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connectVideo(); }, 250);
    });
  }

  private connectControl() {
    if (!this.port || this.stopped || this.control) return;
    const control = net.connect(this.port, '127.0.0.1', () => {
      if (this.stopped) { control.destroy(); return; }
      this.controlReady = true;
      for (const client of this.clients) if (client.readyState === 1) client.send(JSON.stringify({ type: 'control', ready: true }));
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

  private sendTouch(event: TouchControl) {
    if (!this.controlReady || !this.control || this.control.destroyed || !this.control.writable || this.stopped) return;
    try {
      const message = encodeTouchControl(event);
      if (event.action === 'down' ? !!this.activeTouch : this.activeTouch?.pointerId !== event.pointerId) return;
      if (this.control.writableLength > 64 * 1024) { void this.stop('control overloaded'); return; }
      this.control.write(message);
      this.activeTouch = event.action === 'up' || event.action === 'cancel' ? undefined : event;
    } catch { void this.stop('invalid touch'); }
  }

  private broadcast(chunk: Buffer) {
    for (const client of this.clients) {
      if (client.readyState !== 1) continue;
      if (client.bufferedAmount > 4 * 1024 * 1024) { client.terminate(); continue; }
      client.send(chunk, { binary: true });
    }
  }

  private async cleanupForward() {
    if (this.port) {
      try { await this.adb.run(['forward', '--remove', `tcp:${this.port}`], this.serial); } catch {}
      this.port = undefined;
    }
  }
}

@Injectable()
export class StreamService implements OnModuleDestroy {
  private readonly sessions = new Map<string, StreamSession>();
  private pending: Promise<unknown> = Promise.resolve();
  private shuttingDown = false;
  constructor(private readonly adb: AdbService) {}

  async start(serial: string, authSessionId: string, options: StreamOptions) {
    const operation = this.pending.then(async () => {
      if (this.shuttingDown) throw new BadRequestException('服务正在关闭');
      for (const session of this.sessions.values()) {
        if (session.serial === serial && session.authSessionId !== authSessionId) throw new ConflictException('设备正在被其他会话投屏');
      }
      for (const session of this.sessions.values()) if (session.authSessionId === authSessionId) await this.stop(session.id, 'replaced');
      const session = new StreamSession(serial, authSessionId, this.adb, options, () => this.sessions.delete(session.id));
      this.sessions.set(session.id, session);
      try { await session.start(); return session; } catch (error) { await this.stop(session.id, 'startup failed'); throw error; }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  get(id: string) { return this.sessions.get(id); }
  list(authSessionId: string) { return [...this.sessions.values()].filter(item => item.authSessionId === authSessionId).map(item => item.summary()); }
  async stop(id: string, reason = 'manual') { const session = this.sessions.get(id); if (!session) return false; await session.stop(reason); this.sessions.delete(id); return true; }
  async stopForAuth(authSessionId: string) { await this.pending; for (const session of [...this.sessions.values()]) if (session.authSessionId === authSessionId) await this.stop(session.id, 'logout'); }
  async onModuleDestroy() { this.shuttingDown = true; await this.pending; await Promise.all([...this.sessions.keys()].map(id => this.stop(id, 'shutdown'))); }
}

@Controller('streams') @UseGuards(AuthGuard)
class StreamController {
  constructor(private readonly streams: StreamService) {}
  @Post() async start(@Body() body: StartStreamDto, @Req() request: AuthRequest) {
    const session = await this.streams.start(body.serial, request.session.id, body);
    return session.summary();
  }
  @Get() list(@Req() request: AuthRequest) { return this.streams.list(request.session.id); }
  @Delete(':id') async stop(@Param('id') id: string, @Req() request: AuthRequest) {
    const session = this.streams.get(id);
    if (session && session.authSessionId !== request.session.id) throw new ForbiddenException('无权操作该会话');
    return { ok: await this.streams.stop(id) };
  }
}

@Module({ imports: [AuthModule, DevicesModule], providers: [StreamService], controllers: [StreamController], exports: [StreamService] })
export class StreamModule {}