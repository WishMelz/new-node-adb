import {
  BadGatewayException,
  BadRequestException,
  BeforeApplicationShutdown,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { settings } from './config';
import { adbEnvironment, prepareAdbIdentity } from './adb-identity';

const execute = promisify(execFile);
export interface Device {
  serial: string;
  state: string;
  model: string;
  transport: 'network' | 'usb';
}
export interface ScreenSize {
  width: number;
  height: number;
}
export const serialPattern = /^[A-Za-z0-9_.:[\]%-]{1,160}$/;

export function parseDevices(text: string): Device[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map((line) => {
      const [serial, state, ...details] = line.split(/\s+/);
      const model =
        details
          .find((item) => item.startsWith('model:'))
          ?.slice(6)
          .replaceAll('_', ' ') || serial;
      return {
        serial,
        state,
        model,
        transport: serial.includes(':') || serial.includes('_tcp') ? 'network' : 'usb',
      } as Device;
    })
    .filter((device) => device.serial && device.state);
}

export function parseSize(text: string): ScreenSize {
  const match = text.match(/Override size:\s*(\d+)x(\d+)/i) || text.match(/Physical size:\s*(\d+)x(\d+)/i);
  if (!match) throw new BadGatewayException('无法读取设备分辨率');
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function validateSerial(serial: string) {
  if (!serialPattern.test(serial)) throw new BadRequestException('设备标识无效');
}

@Injectable()
export class AdbService implements BeforeApplicationShutdown {
  private server?: ChildProcess;
  private starting?: Promise<void>;
  private socket?: string;
  private environment?: NodeJS.ProcessEnv;
  private closing = false;

  private async ensureServer() {
    if (this.closing) throw new ServiceUnavailableException('ADB 服务正在关闭');
    if (!this.starting) {
      this.starting = this.startServer().catch((error) => {
        this.starting = undefined;
        throw error;
      });
    }
    await this.starting;
    if (this.closing) throw new ServiceUnavailableException('ADB 服务正在关闭');
  }

  private async startServer() {
    try {
      await prepareAdbIdentity(settings.dataDir, settings.adbPath);
      const reservation = net.createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', resolve);
      });
      const port = (reservation.address() as net.AddressInfo).port;
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      if (this.closing) throw new Error('closing');
      this.socket = `tcp:${port}`;
      this.environment = adbEnvironment(settings.dataDir);
      const server = spawn(settings.adbPath, ['-L', this.socket, 'server', 'nodaemon'], {
        env: this.environment,
        windowsHide: true,
        stdio: 'ignore',
      });
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        let connection: net.Socket | undefined;
        let finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          clearTimeout(deadline);
          connection?.destroy();
          if (error) reject(error);
          else resolve();
        };
        const deadline = setTimeout(() => finish(new Error('ADB startup timed out')), 15_000);
        server.once('error', () => finish(new Error('ADB server failed')));
        server.once('exit', () => {
          if (this.server === server) {
            this.server = undefined;
            this.socket = undefined;
            this.starting = undefined;
          }
          finish(new Error('ADB server exited'));
        });
        const connect = () => {
          connection = net.connect(port, '127.0.0.1');
          connection.setTimeout(1000, () => connection?.destroy());
          let response = '';
          connection.on('connect', () => connection?.write('000chost:version'));
          connection.on('data', (chunk) => {
            response += chunk.toString();
            if (/^OKAY0004[0-9a-fA-F]{4}$/.test(response)) finish();
            else if (response.length >= 12) finish(new Error('Unexpected ADB server response'));
          });
          connection.on('error', () => {});
          connection.on('close', () => {
            if (!finished) timer = setTimeout(connect, 50);
          });
        };
        connect();
      });
    } catch {
      this.server?.kill();
      this.server = undefined;
      this.socket = undefined;
      throw new ServiceUnavailableException(
        '无法初始化项目 ADB，请检查 ADB_PATH、DATA_DIR 权限及 .android 密钥；不会覆盖已有密钥',
      );
    }
  }

  async beforeApplicationShutdown() {
    this.closing = true;
    await this.starting?.catch(() => {});
    const server = this.server;
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        server.kill('SIGKILL');
      }, 3000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      server.kill();
    });
  }

  async run(args: string[], serial?: string, timeout = 15_000) {
    if (serial) validateSerial(serial);
    await this.ensureServer();
    try {
      return await execute(
        settings.adbPath,
        ['-H', '127.0.0.1', '-P', this.socket!.slice(4), ...(serial ? ['-s', serial] : []), ...args],
        {
          env: this.environment,
          timeout,
          maxBuffer: 24 * 1024 * 1024,
          encoding: 'buffer',
          windowsHide: true,
        },
      );
    } catch (error) {
      const failure = error as { code?: string; killed?: boolean; stderr?: Buffer };
      if (failure.code === 'ENOENT')
        throw new ServiceUnavailableException('未找到 adb，请安装 Android Platform Tools 并配置 ADB_PATH');
      if (failure.killed) throw new BadGatewayException('ADB 操作超时');
      throw new BadGatewayException(
        failure.stderr?.toString().trim().slice(0, 500) || 'ADB 操作失败，请检查设备授权和连接',
      );
    }
  }

  async text(args: string[], serial?: string) {
    return (await this.run(args, serial)).stdout.toString().trim();
  }
  async devices() {
    return parseDevices(await this.text(['devices', '-l']));
  }
  async ready(serial: string) {
    validateSerial(serial);
    const device = (await this.devices()).find((item) => item.serial === serial);
    if (!device || device.state !== 'device')
      throw new BadRequestException('设备未就绪，请检查连接和 USB 调试授权');
    return device;
  }
  async size(serial: string) {
    return parseSize(await this.text(['shell', 'wm', 'size'], serial));
  }
  async screenshot(serial: string) {
    await this.ready(serial);
    const result = await this.run(['exec-out', 'screencap', '-p'], serial);
    return sharp(result.stdout).webp({ quality: 82, effort: 1 }).toBuffer();
  }
  spawn(serial: string, args: string[]) {
    validateSerial(serial);
    if (this.closing || !this.server || !this.socket)
      throw new ServiceUnavailableException('项目 ADB server 未就绪，请重新连接设备');
    return spawn(settings.adbPath, ['-H', '127.0.0.1', '-P', this.socket.slice(4), '-s', serial, ...args], {
      env: this.environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}
