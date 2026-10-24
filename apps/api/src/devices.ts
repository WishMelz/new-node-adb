import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, Param, Post, Res, UseGuards } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { AdbService, Device, serialPattern, validateSerial } from './adb';
import { AuthGuard, AuthModule } from './auth';
import { settings } from './config';

export interface DeviceRecord {
  serial: string;
  model: string;
  transport: 'network' | 'usb';
  lastConnectedAt: number;
}

@Injectable()
export class DeviceRecordsService {
  private readonly filename = settings.deviceRecordsFile;
  private readonly records = new Map<string, DeviceRecord>();
  private online = new Set<string>();

  constructor() {
    if (!existsSync(this.filename)) return;
    const records: unknown = JSON.parse(readFileSync(this.filename, 'utf8'));
    if (!Array.isArray(records)) throw new Error('Invalid device records');
    for (const record of records) {
      if (!record || typeof record.serial !== 'string' || !serialPattern.test(record.serial) ||
          typeof record.model !== 'string' || !['network', 'usb'].includes(record.transport) ||
          !Number.isSafeInteger(record.lastConnectedAt) || record.lastConnectedAt < 0) throw new Error('Invalid device record');
      this.records.set(record.serial, { serial: record.serial, model: record.model, transport: record.transport, lastConnectedAt: record.lastConnectedAt });
    }
  }

  list() { return [...this.records.values()].sort((first, second) => second.lastConnectedAt - first.lastConnectedAt || first.serial.localeCompare(second.serial)); }

  remember(host: string) {
    validateSerial(host);
    const previous = this.records.get(host);
    this.records.set(host, { serial: host, model: previous?.model || host, transport: 'network', lastConnectedAt: Date.now() });
    this.online.add(host);
    this.persist();
  }

  observe(devices: Device[]) {
    const online = devices.filter(device => device.state === 'device' && serialPattern.test(device.serial));
    let changed = false;
    for (const device of online) {
      const previous = this.records.get(device.serial);
      if (!this.online.has(device.serial) || (previous && (previous.model !== device.model || previous.transport !== device.transport))) {
        this.records.set(device.serial, {
          serial: device.serial, model: device.model, transport: device.transport,
          lastConnectedAt: this.online.has(device.serial) && previous ? previous.lastConnectedAt : Date.now(),
        });
        changed = true;
      }
    }
    this.online = new Set(online.map(device => device.serial));
    if (changed) this.persist();
  }

  remove(serial: string) {
    validateSerial(serial);
    if (this.records.delete(serial)) this.persist();
  }

  private persist() {
    mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.list(), null, 2), { mode: 0o600 });
    renameSync(temporary, this.filename);
  }
}

class DeviceDto { @IsString() @Matches(serialPattern) serial!: string; }
const hostFormatMessage = '请输入设备地址和端口，例如 192.168.1.10:5555';
class HostDto {
  @IsString({ message: hostFormatMessage })
  @Matches(/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9a-fA-F:]+\]):\d{1,5}$/, { message: hostFormatMessage }) host!: string;
}
class TapDto extends DeviceDto {
  @IsInt() @Min(0) @Max(16383) x!: number;
  @IsInt() @Min(0) @Max(16383) y!: number;
}
class SwipeDto extends DeviceDto {
  @IsInt() @Min(0) @Max(16383) startX!: number;
  @IsInt() @Min(0) @Max(16383) startY!: number;
  @IsInt() @Min(0) @Max(16383) endX!: number;
  @IsInt() @Min(0) @Max(16383) endY!: number;
  @IsInt() @Min(80) @Max(2000) duration = 300;
}
class KeyDto extends DeviceDto {
  @IsIn(['home', 'back', 'recent', 'wake', 'sleep', 'enter', 'volumeUp', 'volumeDown']) key!: string;
}
class AppDto extends DeviceDto {
  @IsString() @Matches(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/) packageName!: string;
}
class TextDto extends DeviceDto {
  @IsString() @Matches(/^[A-Za-z0-9 .,?!@_+-]{1,200}$/) text!: string;
}
const keyCodes: Record<string, string> = {
  home: '3', back: '4', recent: '187', wake: '224', sleep: '223', enter: '66', volumeUp: '24', volumeDown: '25',
};

@Controller('devices') @UseGuards(AuthGuard)
class DevicesController {
  constructor(private readonly adb: AdbService, private readonly records: DeviceRecordsService) {}
  @Get() async list() {
    const devices = await this.adb.devices();
    this.records.observe(devices);
    return devices;
  }
  @Get('records') listRecords() { return this.records.list(); }
  @Delete('records/:serial') removeRecord(@Param('serial') serial: string) {
    this.records.remove(serial);
    return { ok: true };
  }
  @Post('connect') async connect(@Body() body: HostDto) {
    const port = Number(body.host.slice(body.host.lastIndexOf(':') + 1));
    if (port < 1 || port > 65535) throw new BadRequestException('端口号必须在 1-65535 之间');
    const message = await this.adb.text(['connect', body.host]);
    if (!/^(?:already )?connected to\s/i.test(message)) throw new BadRequestException(message);
    this.records.remember(body.host);
    return { message };
  }
  @Post('disconnect') async disconnect(@Body() body: DeviceDto) {
    if (!body.serial.includes(':') && !body.serial.includes('_tcp')) throw new BadRequestException('USB 设备请直接拔出连接线');
    return { message: await this.adb.text(['disconnect', body.serial]) };
  }
  @Get(':serial/host') async host(@Param('serial') serial: string) {
    await this.adb.ready(serial);
    const route = await this.adb.text(['shell', 'ip', 'route'], serial);
    const address = route.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (!address) throw new BadRequestException('无法识别网络地址');
    return { host: `${address}:5555` };
  }
  @Get(':serial/screenshot') async screenshot(@Param('serial') serial: string, @Res() reply: FastifyReply) {
    const image = await this.adb.screenshot(serial);
    reply.header('Cache-Control', 'no-store').type('image/webp').send(image);
  }
  @Post('tap') async tap(@Body() body: TapDto) {
    await this.adb.ready(body.serial);
    await this.adb.run(['shell', 'input', 'tap', String(body.x), String(body.y)], body.serial);
    return { ok: true };
  }
  @Post('swipe') async swipe(@Body() body: SwipeDto) {
    await this.adb.ready(body.serial);
    await this.adb.run(['shell', 'input', 'swipe', ...[body.startX, body.startY, body.endX, body.endY, body.duration].map(String)], body.serial);
    return { ok: true };
  }
  @Post('key') async key(@Body() body: KeyDto) {
    await this.adb.ready(body.serial);
    await this.adb.run(['shell', 'input', 'keyevent', keyCodes[body.key]], body.serial);
    return { ok: true };
  }
  @Post('app') async app(@Body() body: AppDto) {
    await this.adb.ready(body.serial);
    await this.adb.run(['shell', 'monkey', '-p', body.packageName, '-c', 'android.intent.category.LAUNCHER', '1'], body.serial);
    return { ok: true };
  }
  @Post('text') async text(@Body() body: TextDto) {
    await this.adb.ready(body.serial);
    const escaped = body.text.replaceAll(' ', '%s');
    await this.adb.run(['shell', 'input', 'text', `'${escaped}'`], body.serial);
    return { ok: true };
  }
}

@Module({ imports: [AuthModule], providers: [AdbService, DeviceRecordsService], controllers: [DevicesController], exports: [AdbService] })
export class DevicesModule {}