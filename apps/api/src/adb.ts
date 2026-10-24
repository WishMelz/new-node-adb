import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { settings } from './config';

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
export class AdbService {
  async run(args: string[], serial?: string, timeout = 15_000) {
    if (serial) validateSerial(serial);
    try {
      return await execute(settings.adbPath, serial ? ['-s', serial, ...args] : args, {
        timeout,
        maxBuffer: 24 * 1024 * 1024,
        encoding: 'buffer',
        windowsHide: true,
      });
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
    return spawn(settings.adbPath, ['-s', serial, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}
