import 'reflect-metadata';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { AdbService, parseDevices, parseSize, validateSerial } from './adb';
import { AuthService } from './auth';
import { DeviceRecordsService } from './devices';
import { createApp, originAllowed } from './main';
import { loadPassword, parseSettings, settings } from './config';
import { encodeTouchControl, StreamService } from './stream';

process.env.ADMIN_PASSWORD = randomBytes(24).toString('hex');
const sessionDirectory = mkdtempSync(path.join(tmpdir(), 'adb-auth-test-'));
settings.sessionFile = path.join(sessionDirectory, 'sessions.json');
settings.deviceRecordsFile = path.join(sessionDirectory, 'devices.json');
after(() => rmSync(sessionDirectory, { recursive: true, force: true }));

test('authentication configuration rejects unsafe or unusable values', () => {
  assert.equal(parseSettings({}).sessionHours, 24);
  assert.equal(parseSettings({ SESSION_HOURS: '168' }).sessionHours, 168);
  for (const environment of [
    { SESSION_HOURS: '23' },
    { SESSION_HOURS: '8761' },
    { PORT: '65536' },
    { COOKIE_SECURE: 'yes' },
    { PUBLIC_ORIGIN: 'https://example.com/' },
    { PUBLIC_ORIGIN: 'https://example.com' },
    { LOGIN_MAX_ATTEMPTS: '0' },
    { LOGIN_WINDOW_MINUTES: 'NaN' },
    { PUBLIC_ORIGIN: 'https://user:pass@example.com' },
  ])
    assert.throws(() => parseSettings(environment));
  assert.equal(
    parseSettings({ PUBLIC_ORIGIN: 'https://example.com', COOKIE_SECURE: 'true' }).secureCookie,
    true,
  );
  const password = process.env.ADMIN_PASSWORD;
  try {
    for (const invalid of ['short', 'a'.repeat(257)]) {
      process.env.ADMIN_PASSWORD = invalid;
      assert.throws(() => loadPassword(), /12-256/);
    }
  } finally {
    process.env.ADMIN_PASSWORD = password;
  }
});

test('ADB device parsing, override resolution and serial validation', () => {
  assert.deepEqual(
    parseDevices(
      'List of devices attached\r\nabc device product:x model:Pixel_8\r\n192.168.1.2:5555 offline\r\n',
    ),
    [
      { serial: 'abc', state: 'device', model: 'Pixel 8', transport: 'usb' },
      { serial: '192.168.1.2:5555', state: 'offline', model: '192.168.1.2:5555', transport: 'network' },
    ],
  );
  assert.deepEqual(parseSize('Physical size: 1080x2400\nOverride size: 720x1600'), {
    width: 720,
    height: 1600,
  });
  assert.throws(() => parseSize('unknown'));
  for (const serial of ['', 'abc;reboot', 'abc\n', 'abc shell']) assert.throws(() => validateSerial(serial));
  validateSerial('[::1]:5555');
});

test('random sessions, revocation, expiry and login throttling', () => {
  const auth = new AuthService();
  const first = auth.login(process.env.ADMIN_PASSWORD!, 'local');
  const second = auth.login(process.env.ADMIN_PASSWORD!, 'local');
  assert.notEqual(first.token, second.token);
  assert.equal(auth.find(first.token)?.id, first.session.id);
  auth.revoke(first.token);
  assert.equal(auth.find(first.token), undefined);
  second.session.expiresAt = 0;
  assert.equal(auth.find(second.token), undefined);
  for (let attempt = 0; attempt < 5; attempt += 1) assert.throws(() => auth.login('wrong', 'limited'));
  assert.throws(() => auth.login(process.env.ADMIN_PASSWORD!, 'limited'));
});

test('device records persist, deduplicate and retain deletion during polling', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const records = new DeviceRecordsService();
  const device = {
    serial: '192.168.1.10:5555',
    model: 'Pixel 8',
    state: 'device',
    transport: 'network' as const,
  };
  records.remember(device.serial);
  records.observe([device, { ...device, serial: 'unauthorized-device', state: 'unauthorized' }]);
  assert.deepEqual(records.list(), [
    { serial: device.serial, model: device.model, transport: 'network', lastConnectedAt: 1000, note: '' },
  ]);
  context.mock.timers.setTime(2000);
  records.observe([device]);
  assert.equal(records.list()[0].lastConnectedAt, 1000);
  records.remember(device.serial);
  assert.equal(records.list().length, 1);
  assert.equal(records.list()[0].lastConnectedAt, 2000);
  const usb = { serial: 'usb-device', model: 'USB phone', state: 'device', transport: 'usb' as const };
  context.mock.timers.setTime(3000);
  records.observe([device, usb]);
  assert.equal(records.list()[0].serial, usb.serial);
  records.observe([]);
  assert.equal(records.list().length, 2);
  assert.deepEqual(new DeviceRecordsService().list(), records.list());
  assert.deepEqual(JSON.parse(readFileSync(settings.deviceRecordsFile, 'utf8')), records.list());
  records.updateNote(device.serial, ' 客厅手机 ');
  assert.equal(records.list().find((record) => record.serial === device.serial)?.note, '客厅手机');
  records.observe([device]);
  assert.equal(records.list().find((record) => record.serial === device.serial)?.note, '客厅手机');
  records.remember(device.serial);
  assert.equal(records.list().find((record) => record.serial === device.serial)?.note, '客厅手机');
  records.updateNote(device.serial, '\u{1F4F1}'.repeat(120));
  assert.equal(
    new DeviceRecordsService().list().find((record) => record.serial === device.serial)?.note,
    '\u{1F4F1}'.repeat(120),
  );
  records.observe([device]);
  records.remove(device.serial);
  records.observe([device]);
  assert.equal(
    records.list().some((record) => record.serial === device.serial),
    false,
  );
  assert.equal(
    new DeviceRecordsService().list().some((record) => record.serial === device.serial),
    false,
  );
  records.remember(device.serial);
  assert.equal(records.list().length, 2);
  assert.throws(() => records.remove('../sessions.json'));
  records.remove(device.serial);
  records.remove(usb.serial);
  writeFileSync(
    settings.deviceRecordsFile,
    JSON.stringify([
      { serial: device.serial, model: device.model, transport: device.transport, lastConnectedAt: 4000 },
    ]),
  );
  assert.deepEqual(new DeviceRecordsService().list(), [
    {
      serial: device.serial,
      model: device.model,
      transport: device.transport,
      lastConnectedAt: 4000,
      note: '',
    },
  ]);
  rmSync(settings.deviceRecordsFile, { force: true });
});

test('sessions last at least 24 hours and survive restarts without persisting credentials', (context) => {
  const now = Date.now();
  context.mock.timers.enable({ apis: ['Date'], now });
  const auth = new AuthService();
  const { token, session } = auth.login(process.env.ADMIN_PASSWORD!, 'persistent');
  assert.ok(settings.sessionHours >= 24);
  assert.equal(session.expiresAt, now + settings.sessionHours * 3_600_000);
  const stored = readFileSync(settings.sessionFile, 'utf8');
  assert.ok(!stored.includes(token));
  assert.ok(!stored.includes(process.env.ADMIN_PASSWORD!));
  context.mock.timers.setTime(now + 23 * 3_600_000);
  const restarted = new AuthService();
  assert.deepEqual(restarted.find(token), session);
  restarted.revoke(token);
  assert.equal(new AuthService().find(token), undefined);

  const expiring = restarted.login(process.env.ADMIN_PASSWORD!, 'persistent');
  context.mock.timers.setTime(expiring.session.expiresAt - 1);
  assert.ok(new AuthService().find(expiring.token));
  context.mock.timers.setTime(expiring.session.expiresAt);
  assert.equal(new AuthService().find(expiring.token), undefined);
  assert.equal(restarted.find(expiring.token), undefined);

  const current = restarted.login(process.env.ADMIN_PASSWORD!, 'persistent');
  const password = process.env.ADMIN_PASSWORD!;
  try {
    process.env.ADMIN_PASSWORD = randomBytes(24).toString('hex');
    assert.equal(new AuthService().find(current.token), undefined);
  } finally {
    process.env.ADMIN_PASSWORD = password;
  }
});

test('stream ownership, concurrent replacement, exit cleanup and shutdown', async () => {
  assert.ok(existsSync(settings.scrcpyPath), 'scrcpy server must be installed');
  const processes: EventEmitter[] = [];
  const forwards: string[][] = [];
  const adb = {
    ready: async () => {},
    size: async () => ({ width: 1080, height: 2400 }),
    run: async (args: string[]) => {
      forwards.push(args);
    },
    text: async () => '27190',
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { kill() {} });
      processes.push(child);
      return child as unknown as ChildProcess;
    },
  } as unknown as AdbService;
  const streams = new StreamService(adb);
  const options = { maxSize: 1280, maxFps: 30, bitRate: 4_000_000 };
  try {
    await streams.start('abc', 'owner', options);
    await assert.rejects(streams.start('abc', 'other', options), /其他会话/);
    assert.equal(streams.list('other').length, 0);
    const [, latest] = await Promise.all([
      streams.start('abc', 'owner', options),
      streams.start('def', 'owner', options),
    ]);
    assert.equal(streams.list('owner').length, 1);
    assert.equal(streams.get(latest.id)?.serial, 'def');
    processes.at(-1)!.emit('exit', 1);
    assert.equal(streams.list('owner').length, 0);
    assert.ok(forwards.some((args) => args[0] === 'forward' && args[1] === '--remove'));
    await streams.start('abc', 'owner', options);
    await streams.stopForAuth('owner');
    assert.equal(streams.list('owner').length, 0);
  } finally {
    await streams.onModuleDestroy();
  }
});

test('Nest serves the frontend and API on the same listener without masking missing routes', async () => {
  const webRoot = path.join(sessionDirectory, 'web');
  mkdirSync(path.join(webRoot, 'assets'), { recursive: true });
  const html =
    '<!doctype html><html><body><div id="app"></div><script src="/assets/app.js"></script></body></html>';
  const javascript = 'globalThis.appLoaded = true;';
  writeFileSync(path.join(webRoot, 'index.html'), html);
  writeFileSync(path.join(webRoot, 'assets/app.js'), javascript);
  const app = await createApp(webRoot);
  try {
    const server = app.getHttpAdapter().getInstance();
    for (const url of ['/', '/index.html']) {
      const response = await server.inject(url);
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['content-type']), /text\/html/);
      assert.equal(response.body, html);
    }
    const asset = await server.inject('/assets/app.js');
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers['content-type']), /javascript/);
    assert.equal(asset.body, javascript);
    const health = await server.inject('/api/health');
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().ok, true);
    assert.equal((await server.inject('/api/devices')).statusCode, 401);
    for (const url of ['/api/unknown', '/assets/missing.js', '/ws/streams/missing', '/unknown']) {
      assert.equal((await server.inject(url)).statusCode, 404);
    }
  } finally {
    await app.close();
  }
});

test('HTTP auth, origin protection and DTO validation', async () => {
  let app = await createApp();
  try {
    let server = app.getHttpAdapter().getInstance();
    assert.equal((await server.inject('/api/health')).statusCode, 200);
    assert.deepEqual((await server.inject('/api/auth/config')).json(), {
      mode: 'password',
      sessionHours: settings.sessionHours,
    });
    assert.equal((await server.inject('/api/devices')).statusCode, 401);
    const blocked = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://untrusted.invalid' },
      payload: { password: process.env.ADMIN_PASSWORD },
    });
    assert.equal(blocked.statusCode, 403);
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: process.env.ADMIN_PASSWORD },
    });
    assert.equal(login.statusCode, 201);
    const setCookie = String(login.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, new RegExp(`Max-Age=${settings.sessionHours * 3600}(?:;|$)`, 'i'));
    const headers = { cookie: setCookie.split(';')[0] };
    await app.close();
    app = await createApp();
    server = app.getHttpAdapter().getInstance();
    assert.equal((await server.inject({ url: '/api/auth/session', headers })).statusCode, 200);
    assert.equal(
      (
        await server.inject({
          method: 'POST',
          url: '/api/devices/tap',
          headers,
          payload: { serial: 'abc;bad', x: -1, y: 0 },
        })
      ).statusCode,
      400,
    );
    for (const host of ['', '192.168.3.110', 'http://192.168.1.10:5555', 'abc;reboot:5555', 123]) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/devices/connect',
        headers,
        payload: { host },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(
        [...new Set(response.json().message)],
        ['请输入设备地址和端口，例如 192.168.1.10:5555'],
      );
    }
    for (const host of ['192.168.1.10:0', '[::1]:65536']) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/devices/connect',
        headers,
        payload: { host },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().message, '端口号必须在 1-65535 之间');
    }
    assert.equal((await server.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode, 201);
    await app.close();
    app = await createApp();
    server = app.getHttpAdapter().getInstance();
    assert.equal((await server.inject({ url: '/api/auth/session', headers })).statusCode, 401);
    assert.equal((await server.inject('/api/unknown')).statusCode, 404);
    assert.equal(originAllowed('https://untrusted.invalid', 'localhost'), false);
  } finally {
    await app.close();
  }
});

test('device record HTTP routes authenticate, save successful connections and delete without disconnecting', async (context) => {
  let app = await createApp();
  try {
    let server = app.getHttpAdapter().getInstance();
    const serial = '192.168.1.20:5555';
    assert.equal((await server.inject('/api/devices/records')).statusCode, 401);
    assert.equal(
      (await server.inject({ method: 'DELETE', url: `/api/devices/records/${encodeURIComponent(serial)}` }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await server.inject({
          method: 'PATCH',
          url: `/api/devices/records/${encodeURIComponent(serial)}`,
          payload: { note: '客厅手机' },
        })
      ).statusCode,
      401,
    );
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: process.env.ADMIN_PASSWORD },
    });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const adb = app.get(AdbService);
    const text = context.mock.method(adb, 'text', async () => 'cannot connect to device');
    context.mock.method(adb, 'devices', async () => [
      { serial, model: 'Pixel 8', state: 'device', transport: 'network' as const },
    ]);
    assert.equal(
      (
        await server.inject({
          method: 'POST',
          url: '/api/devices/connect',
          headers,
          payload: { host: serial },
        })
      ).statusCode,
      400,
    );
    assert.deepEqual((await server.inject({ url: '/api/devices/records', headers })).json(), []);
    text.mock.mockImplementation(async () => `connected to ${serial}`);
    assert.equal(
      (
        await server.inject({
          method: 'POST',
          url: '/api/devices/connect',
          headers,
          payload: { host: serial },
        })
      ).statusCode,
      201,
    );
    assert.equal((await server.inject({ url: '/api/devices', headers })).statusCode, 200);
    text.mock.mockImplementation(async () => `already connected to ${serial}`);
    await server.inject({ method: 'POST', url: '/api/devices/connect', headers, payload: { host: serial } });
    const saved = (await server.inject({ url: '/api/devices/records', headers })).json();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].model, 'Pixel 8');
    assert.equal(saved[0].note, '');
    assert.equal(
      (
        await server.inject({
          method: 'PATCH',
          url: `/api/devices/records/${encodeURIComponent(serial)}`,
          headers,
          payload: { note: ' 客厅手机 ' },
        })
      ).statusCode,
      200,
    );
    assert.equal((await server.inject({ url: '/api/devices/records', headers })).json()[0].note, '客厅手机');
    assert.equal((await server.inject({ url: '/api/devices', headers })).statusCode, 200);
    assert.equal((await server.inject({ url: '/api/devices/records', headers })).json()[0].note, '客厅手机');
    for (const note of ['\u{1F4F1}'.repeat(120), '\u2708\uFE0F'.repeat(60), '', '客厅手机']) {
      const response = await server.inject({
        method: 'PATCH',
        url: `/api/devices/records/${encodeURIComponent(serial)}`,
        headers,
        payload: { note },
      });
      assert.equal(response.statusCode, 200);
      assert.equal((await server.inject({ url: '/api/devices/records', headers })).json()[0].note, note);
      assert.equal(new DeviceRecordsService().list()[0].note, note);
    }
    for (const note of ['x'.repeat(121), '\u{1F4F1}'.repeat(121), '\u2708\uFE0F'.repeat(61), 123, null]) {
      const response = await server.inject({
        method: 'PATCH',
        url: `/api/devices/records/${encodeURIComponent(serial)}`,
        headers,
        payload: { note },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(new DeviceRecordsService().list()[0].note, '客厅手机');
    }
    assert.equal(
      (
        await server.inject({
          method: 'PATCH',
          url: '/api/devices/records/192.168.1.99%3A5555',
          headers,
          payload: { note: '不存在' },
        })
      ).statusCode,
      404,
    );
    await app.close();
    app = await createApp();
    server = app.getHttpAdapter().getInstance();
    assert.deepEqual((await server.inject({ url: '/api/devices/records', headers })).json(), [
      { ...saved[0], note: '客厅手机' },
    ]);
    const restartedAdb = app.get(AdbService);
    const disconnect = context.mock.method(restartedAdb, 'text', async () => {
      throw new Error('Must not run ADB when deleting a record');
    });
    assert.equal(
      (
        await server.inject({
          method: 'DELETE',
          url: `/api/devices/records/${encodeURIComponent(serial)}`,
          headers: { ...headers, origin: 'https://untrusted.invalid' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await server.inject({
          method: 'DELETE',
          url: `/api/devices/records/${encodeURIComponent(serial)}`,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(disconnect.mock.callCount(), 0);
    assert.deepEqual(new DeviceRecordsService().list(), []);
  } finally {
    await app.close();
  }
});

test('scrcpy touch control messages encode pointer actions', () => {
  const touch = {
    action: 'move' as const,
    pointerId: 7,
    x: 321,
    y: 654,
    screenWidth: 1080,
    screenHeight: 2400,
  };
  const message = encodeTouchControl(touch);
  assert.equal(message.length, 32);
  assert.equal(message[0], 2);
  assert.equal(message[1], 2);
  assert.equal(message.readBigUInt64BE(2), 7n);
  assert.equal(message.readInt32BE(10), 321);
  assert.equal(message.readInt32BE(14), 654);
  assert.equal(message.readUInt16BE(18), 1080);
  assert.equal(message.readUInt16BE(20), 2400);
  assert.equal(message.readUInt16BE(22), 65535);
  assert.equal(message.readUInt32BE(24), 0);
  assert.equal(message.readUInt32BE(28), 0);
  const release = encodeTouchControl({ ...touch, action: 'up' });
  assert.equal(release[1], 1);
  assert.equal(release.readUInt16BE(22), 0);
  assert.deepEqual(encodeTouchControl({ ...touch, action: 'cancel' }), release);
  for (const invalid of [
    { x: -1 },
    { x: 1080 },
    { y: 2400 },
    { screenWidth: 0 },
    { screenHeight: 65536 },
    { pointerId: 1.5 },
    { pointerId: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => encodeTouchControl({ ...touch, ...invalid }));
  }
});

test('video handshake, real-time touch transport and disconnect cleanup', { timeout: 8000 }, async () => {
  const connections: net.Socket[] = [];
  const packets: Buffer[] = [];
  const packetEvents = new EventEmitter();
  const server = net.createServer((connection) => {
    connections.push(connection);
    if (connections.length === 1) connection.write(Buffer.from([0]));
    else {
      connection.on('data', (data) => {
        packets.push(data);
        packetEvents.emit('packet');
      });
      connections[0].write(Buffer.from([0, 0, 0, 1, 0x67]));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  const forwards: string[][] = [];
  const adb = {
    ready: async () => {},
    size: async () => ({ width: 1080, height: 2400 }),
    run: async (args: string[]) => {
      forwards.push(args);
    },
    text: async () => String(port),
    spawn: (_serial: string, args: string[]) => {
      assert.ok(args.includes('control=true'));
      assert.ok(args.indexOf('send_dummy_byte=true') > args.indexOf('raw_stream=true'));
      return Object.assign(new EventEmitter(), { kill() {} });
    },
  } as unknown as AdbService;
  const streams = new StreamService(adb);
  const viewerServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(viewerServer, 'listening');
  let viewer: WebSocket | undefined;
  try {
    const session = await streams.start('abc', 'owner', { maxSize: 1280, maxFps: 30, bitRate: 4_000_000 });
    viewerServer.on('connection', (client) => session.attach(client));
    viewer = new WebSocket(`ws://127.0.0.1:${(viewerServer.address() as net.AddressInfo).port}`);
    const ready = new Promise<void>((resolve) =>
      viewer!.on('message', (data, binary) => {
        if (!binary && JSON.parse(data.toString()).ready) resolve();
      }),
    );
    const videoData = new Promise<Buffer>((resolve) =>
      viewer!.on('message', (data, binary) => {
        if (binary) resolve(data as Buffer);
      }),
    );
    await ready;
    assert.equal(connections.length, 2);
    assert.deepEqual(await videoData, Buffer.from([0, 0, 0, 1, 0x67]));
    const touch = { type: 'touch', pointerId: 1, x: 200, y: 400, screenWidth: 576, screenHeight: 1280 };
    for (const action of ['down', 'move', 'up'] as const) {
      const arrived = once(packetEvents, 'packet');
      viewer.send(JSON.stringify({ ...touch, action }));
      await arrived;
    }
    const bytes = Buffer.concat(packets);
    assert.equal(bytes.length, 96);
    assert.deepEqual([bytes[1], bytes[33], bytes[65]], [0, 2, 1]);
    assert.equal(bytes.readUInt16BE(18), 576);
    assert.equal(bytes.readUInt16BE(20), 1280);
    const downArrived = once(packetEvents, 'packet');
    viewer.send(JSON.stringify({ ...touch, action: 'down' }));
    await downArrived;
    const released = once(packetEvents, 'packet');
    viewer.close();
    await released;
    assert.equal(Buffer.concat(packets).at(-31), 1);
    await streams.onModuleDestroy();
    assert.ok(forwards.some((args) => args[1] === '--remove'));
  } finally {
    viewer?.terminate();
    await streams.onModuleDestroy();
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const client of viewerServer.clients) client.terminate();
    await new Promise<void>((resolve) => viewerServer.close(() => resolve()));
  }
});
