import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  NotFoundException,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsString, Matches, Max, Min, ValidateBy } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { AdbService, Device, serialPattern, validateSerial } from './adb';
import { AuthGuard, AuthModule } from './auth';
import { StorageModule, StorageService, StoredDevice } from './storage';

export type DeviceRecord = StoredDevice;

@Injectable()
export class DeviceRecordsService {
  private online = new Set<string>();

  constructor(private readonly store: StorageService = new StorageService()) {}

  list() {
    return this.store
      .read((database) =>
        database
          .prepare('SELECT * FROM devices')
          .all()
          .map((record) => ({ ...record }) as unknown as DeviceRecord),
      )
      .sort(
        (first, second) =>
          second.lastConnectedAt - first.lastConnectedAt || first.serial.localeCompare(second.serial),
      );
  }

  remember(host: string) {
    validateSerial(host);
    this.store.transaction((database) => {
      database
        .prepare(
          `
        INSERT INTO devices (serial, model, transport, lastConnectedAt, note) VALUES (?, ?, 'network', ?, '')
        ON CONFLICT(serial) DO UPDATE SET transport = 'network', lastConnectedAt = excluded.lastConnectedAt
      `,
        )
        .run(host, host, Date.now());
    });
    this.online.add(host);
  }

  observe(devices: Device[]) {
    const online = devices.filter((device) => device.state === 'device' && serialPattern.test(device.serial));
    this.store.transaction((database) => {
      for (const device of online) {
        const previous = database.prepare('SELECT * FROM devices WHERE serial = ?').get(device.serial);
        if (
          !this.online.has(device.serial) ||
          (previous && (previous.model !== device.model || previous.transport !== device.transport))
        ) {
          database
            .prepare(
              `
          INSERT INTO devices (serial, model, transport, lastConnectedAt, note) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(serial) DO UPDATE SET model = excluded.model, transport = excluded.transport,
            lastConnectedAt = excluded.lastConnectedAt
        `,
            )
            .run(
              device.serial,
              device.model,
              device.transport,
              this.online.has(device.serial) && previous ? previous.lastConnectedAt : Date.now(),
              previous?.note ?? '',
            );
        }
      }
    });
    this.online = new Set(online.map((device) => device.serial));
  }

  remove(serial: string) {
    validateSerial(serial);
    this.store.transaction((database) =>
      database.prepare('DELETE FROM devices WHERE serial = ?').run(serial),
    );
  }

  updateNote(serial: string, note: string) {
    validateSerial(serial);
    return this.store.transaction((database) => {
      const record = database
        .prepare('UPDATE devices SET note = ? WHERE serial = ? RETURNING *')
        .get(note.trim(), serial);
      return record ? ({ ...record } as unknown as DeviceRecord) : undefined;
    });
  }
}

class DeviceDto {
  @IsString() @Matches(serialPattern) serial!: string;
}
class DeviceRecordNoteDto {
  @IsString()
  @ValidateBy(
    {
      name: 'noteMaxLength',
      validator: {
        validate: (value: unknown) => typeof value === 'string' && [...value].length <= 120,
      },
    },
    { message: '备注最多 120 个字符' },
  )
  note!: string;
}
const hostFormatMessage = '请输入设备地址和端口，例如 192.168.1.10:5555';
class HostDto {
  @IsString({ message: hostFormatMessage })
  @Matches(/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9a-fA-F:]+\]):\d{1,5}$/, { message: hostFormatMessage })
  host!: string;
}
class PairDto extends HostDto {
  @IsString({ message: '请输入 6 位数字配对码' })
  @Matches(/^\d{6}$/, { message: '请输入 6 位数字配对码' })
  code!: string;
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
  home: '3',
  back: '4',
  recent: '187',
  wake: '224',
  sleep: '223',
  enter: '66',
  volumeUp: '24',
  volumeDown: '25',
};

@Controller('devices')
@UseGuards(AuthGuard)
class DevicesController {
  constructor(
    private readonly adb: AdbService,
    private readonly records: DeviceRecordsService,
  ) {}
  @Get() async list() {
    const devices = await this.adb.devices();
    this.records.observe(devices);
    return devices;
  }
  @Get('records') listRecords() {
    return this.records.list();
  }
  @Delete('records/:serial') removeRecord(@Param('serial') serial: string) {
    this.records.remove(serial);
    return { ok: true };
  }
  @Patch('records/:serial') updateRecordNote(
    @Param('serial') serial: string,
    @Body() body: DeviceRecordNoteDto,
  ) {
    if (!this.records.updateNote(serial, body.note)) throw new NotFoundException('设备记录不存在');
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
  @Post('pair') async pair(@Body() body: PairDto) {
    const port = Number(body.host.slice(body.host.lastIndexOf(':') + 1));
    if (port < 1 || port > 65535) throw new BadRequestException('端口号必须在 1-65535 之间');
    const message = await this.adb.text(['pair', body.host, body.code]);
    if (!/successfully paired/i.test(message))
      throw new BadRequestException(message || '无线配对失败，请检查地址、端口和配对码');
    return { message };
  }
  @Post('disconnect') async disconnect(@Body() body: DeviceDto) {
    if (!body.serial.includes(':') && !body.serial.includes('_tcp'))
      throw new BadRequestException('USB 设备请直接拔出连接线');
    return { message: await this.adb.text(['disconnect', body.serial]) };
  }
  @Get(':serial/host') async host(@Param('serial') serial: string) {
    await this.adb.ready(serial);
    const route = await this.adb.text(['shell', 'ip', 'route'], serial);
    const address = route.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (!address) throw new BadRequestException('无法识别网络地址');
    return { host: `${address}:5555` };
  }
  @Get(':serial/apps') async apps(@Param('serial') serial: string) {
    await this.adb.ready(serial);
    const output = await this.adb.text(['shell', 'pm', 'list', 'packages', '-3'], serial);
    const packages = [
      ...new Set(
        output
          .split(/\r?\n/)
          .map((line) => line.trim().replace(/^package:/, ''))
          .filter((name) => /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(name)),
      ),
    ]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 500);
    return { packages };
  }
  @Get(':serial/screenshot') async screenshot(
    @Param('serial') serial: string,
    @Query('maxSize') maxSize: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    let limit: number | undefined;
    if (maxSize !== undefined && maxSize !== '') {
      const parsed = Number(maxSize);
      if (!Number.isSafeInteger(parsed) || parsed < 320 || parsed > 1920)
        throw new BadRequestException('maxSize 必须为 320-1920 的整数');
      limit = parsed;
    }
    const frame = await this.adb.screenshotFrame(serial, limit);
    reply.header('Cache-Control', 'no-store');
    if (frame.width && frame.height) {
      reply.header('X-Device-Width', String(frame.width));
      reply.header('X-Device-Height', String(frame.height));
    }
    reply.type('image/webp').send(frame.buffer);
  }
  @Post('tap') async tap(@Body() body: TapDto) {
    await this.adb.ready(body.serial);
    await this.adb.run(['shell', 'input', 'tap', String(body.x), String(body.y)], body.serial);
    return { ok: true };
  }
  @Post('swipe') async swipe(@Body() body: SwipeDto) {
    await this.adb.ready(body.serial);
    await this.adb.run(
      [
        'shell',
        'input',
        'swipe',
        ...[body.startX, body.startY, body.endX, body.endY, body.duration].map(String),
      ],
      body.serial,
    );
    return { ok: true };
  }
  @Post('key') async key(@Body() body: KeyDto) {
    await this.adb.ready(body.serial);
    await this.adb.run(['shell', 'input', 'keyevent', keyCodes[body.key]], body.serial);
    return { ok: true };
  }
  @Post('app') async app(@Body() body: AppDto) {
    await this.adb.ready(body.serial);
    await this.adb.run(
      ['shell', 'monkey', '-p', body.packageName, '-c', 'android.intent.category.LAUNCHER', '1'],
      body.serial,
    );
    return { ok: true };
  }
  @Post('text') async text(@Body() body: TextDto) {
    await this.adb.ready(body.serial);
    const escaped = body.text.replaceAll(' ', '%s');
    await this.adb.run(['shell', 'input', 'text', `'${escaped}'`], body.serial);
    return { ok: true };
  }
}

@Module({
  imports: [AuthModule, StorageModule],
  providers: [AdbService, DeviceRecordsService],
  controllers: [DevicesController],
  exports: [AdbService],
})
export class DevicesModule {}
