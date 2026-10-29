import 'reflect-metadata';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { AdbService, parseDevices, parseSize, validateSerial } from './adb';
import { AuthService } from './auth';
import { TwoFactorService } from './two-factor';
import { TOTP } from 'otpauth';
import { DeviceRecordsService } from './devices';
import { createApp, originAllowed } from './main';
import { loadPassword, parseSettings, settings } from './config';
import { encodeTouchControl, StreamService, StreamSession } from './stream';

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
    for (const configured of ['x', 'short', 'a'.repeat(257)]) {
      process.env.ADMIN_PASSWORD = configured;
      assert.equal(loadPassword(), configured);
    }
  } finally {
    process.env.ADMIN_PASSWORD = password;
  }
});

test('bootstrap password accepts any nonempty length', (context) => {
  const password = process.env.ADMIN_PASSWORD;
  let contents = '';
  context.mock.method(fs, 'existsSync', () => true);
  context.mock.method(fs, 'mkdirSync', () => undefined);
  context.mock.method(fs, 'readFileSync', () => contents);
  try {
    delete process.env.ADMIN_PASSWORD;
    for (const configured of ['x', 'short', 'a'.repeat(257)]) {
      contents = `${configured}\r\n`;
      assert.equal(loadPassword(), configured);
    }
    for (const empty of ['', ' \r\n']) {
      contents = empty;
      assert.throws(() => loadPassword(), /must not be empty/);
    }
  } finally {
    process.env.ADMIN_PASSWORD = password;
  }
});

test('HTTP password authentication accepts short and long passwords without truncation', async () => {
  const password = process.env.ADMIN_PASSWORD;
  try {
    for (const configured of ['x', 'a'.repeat(257)]) {
      process.env.ADMIN_PASSWORD = configured;
      const app = await createApp();
      try {
        const server = app.getHttpAdapter().getInstance();
        for (const invalid of ['', null, 123]) {
          const response = await server.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { password: invalid },
          });
          assert.equal(response.statusCode, 400);
        }
        const wrong = await server.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { password: configured.length > 1 ? configured.slice(0, -1) : 'wrong' },
        });
        assert.equal(wrong.statusCode, 401);
        const login = await server.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { password: configured },
        });
        assert.equal(login.statusCode, 201);
        const setup = await server.inject({
          method: 'POST',
          url: '/api/auth/two-factor/setup',
          headers: { cookie: String(login.headers['set-cookie']).split(';')[0] },
          payload: { password: configured },
        });
        assert.equal(setup.statusCode, 201);
      } finally {
        await app.close();
      }
    }
  } finally {
    process.env.ADMIN_PASSWORD = password;
  }
});

test('stream configuration validates resource limits', () => {
  const defaults = parseSettings({});
  assert.equal(defaults.streamMaxSize, 1280);
  assert.equal(defaults.streamMaxFps, 30);
  assert.equal(defaults.streamBitRate, 3_000_000);
  assert.equal(defaults.streamMaxSessions, 2);
  assert.equal(parseSettings({ STREAM_BIT_RATE: '1500000' }).streamBitRate, 1_500_000);
  for (const environment of [
    { STREAM_MAX_SIZE: '479' },
    { STREAM_MAX_SIZE: '1921' },
    { STREAM_MAX_FPS: '9' },
    { STREAM_MAX_FPS: '61' },
    { STREAM_BIT_RATE: '499999' },
    { STREAM_BIT_RATE: '12000001' },
    { STREAM_BIT_RATE: 'NaN' },
    { STREAM_MAX_SESSIONS: '0' },
    { STREAM_MAX_SESSIONS: '17' },
    { STREAM_MAX_SESSIONS: '1.5' },
  ])
    assert.throws(() => parseSettings(environment));
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
  assert.equal(auth.find(first.token), undefined);
  assert.equal(auth.isActive(first.session.id), false);
  assert.equal(auth.find(second.token)?.id, second.session.id);
  assert.equal(auth.isActive(second.session.id), true);
  assert.throws(() => auth.login('wrong', 'local'));
  assert.equal(auth.find(second.token)?.id, second.session.id);
  const restored = new AuthService();
  assert.equal(restored.find(first.token), undefined);
  assert.equal(restored.find(second.token)?.id, second.session.id);
  auth.revoke(first.token);
  assert.equal(auth.find(first.token), undefined);
  assert.equal(auth.find(second.token)?.id, second.session.id);
  second.session.expiresAt = 0;
  assert.equal(auth.find(second.token), undefined);
  for (let attempt = 0; attempt < 5; attempt += 1) assert.throws(() => auth.login('wrong', 'limited'));
  assert.throws(() => auth.login(process.env.ADMIN_PASSWORD!, 'limited'));
});

test('optional two-factor enrollment, replay prevention, recovery and trusted browser expiry', (context) => {
  const filename = path.join(sessionDirectory, 'two-factor.json');
  context.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  try {
    const factor = new TwoFactorService();
    assert.equal(factor.enabled, false);
    const setup = factor.begin('owner');
    assert.equal(factor.enabled, false);
    const totp = new TOTP({ secret: setup.secret });
    assert.throws(() => factor.enable('other', totp.generate()));
    assert.throws(() => factor.enable('owner', 'invalid'));
    const { recoveryCodes } = factor.enable('owner', totp.generate());
    assert.equal(factor.verify(totp.generate()), false);
    assert.equal(recoveryCodes.length, 10);
    assert.equal(factor.verify(recoveryCodes[0]), true);
    assert.equal(new TwoFactorService().verify(recoveryCodes[0]), false);
    context.mock.timers.tick(30_000);
    assert.equal(factor.verify(totp.generate()), true);
    assert.equal(new TwoFactorService().verify(totp.generate()), false);
    const trusted = factor.remember(7);
    assert.equal(new TwoFactorService().isTrusted(trusted.token), true);
    const contents = readFileSync(filename, 'utf8');
    assert.ok(!contents.includes(trusted.token));
    assert.ok(!contents.includes(recoveryCodes[1]));
    assert.ok(!contents.includes(process.env.ADMIN_PASSWORD!));
    assert.equal(factor.isTrusted('forged'), false);
    assert.throws(() => factor.remember(91));
    context.mock.timers.setTime(trusted.expiresAt);
    assert.equal(factor.isTrusted(trusted.token), false);
    const another = factor.remember(1);
    factor.revokeTrusted();
    assert.equal(new TwoFactorService().isTrusted(another.token), false);
    mkdirSync(`${filename}.tmp`);
    assert.throws(() => factor.disable());
    assert.equal(factor.enabled, true);
    rmSync(`${filename}.tmp`, { recursive: true });
    factor.disable();
    assert.equal(new TwoFactorService().enabled, false);
    const expired = factor.begin('owner');
    context.mock.timers.setTime(expired.expiresAt);
    assert.throws(() => factor.enable('owner', new TOTP({ secret: expired.secret }).generate()));
  } finally {
    rmSync(filename, { force: true });
  }
});

test('two-factor login challenges cannot replace sessions until verification succeeds', (context) => {
  const filename = path.join(sessionDirectory, 'two-factor.json');
  context.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  try {
    const factor = new TwoFactorService();
    const auth = new AuthService(factor);
    const first = auth.login(process.env.ADMIN_PASSWORD!, 'first');
    const setup = factor.begin(first.session.id);
    const { recoveryCodes } = auth.enableFactor(
      first.session.id,
      new TOTP({ secret: setup.secret }).generate(),
      'first',
    );
    const challenge = auth.beginLogin(process.env.ADMIN_PASSWORD!, 'next');
    assert.ok('challenge' in challenge);
    assert.ok(auth.find(first.token));
    assert.throws(() => auth.completeLogin(challenge.challenge, 'invalid', 7, 'next'));
    assert.ok(auth.find(first.token));
    const second = auth.completeLogin(challenge.challenge, recoveryCodes[0], 7, 'next');
    assert.equal(auth.find(first.token), undefined);
    assert.ok(auth.find(second.token));
    assert.throws(() => auth.completeLogin(challenge.challenge, recoveryCodes[1], 7, 'next'));
    const trustedToken = second.trusted?.token;
    assert.ok(trustedToken);
    assert.throws(() => auth.beginLogin('wrong', 'trusted', trustedToken));
    const trusted = auth.beginLogin(process.env.ADMIN_PASSWORD!, 'trusted', trustedToken);
    assert.ok('token' in trusted);
    const expired = auth.beginLogin(process.env.ADMIN_PASSWORD!, 'expiry');
    assert.ok('challenge' in expired);
    context.mock.timers.tick(5 * 60_000);
    assert.throws(() => auth.completeLogin(expired.challenge, recoveryCodes[1], 0, 'expiry'));
    const revoked = auth.beginLogin(process.env.ADMIN_PASSWORD!, 'revoked');
    assert.ok('challenge' in revoked);
    factor.revokeTrusted();
    assert.throws(() => auth.completeLogin(revoked.challenge, recoveryCodes[1], 0, 'revoked'));
    const limited = auth.beginLogin(process.env.ADMIN_PASSWORD!, 'limited-2fa');
    assert.ok('challenge' in limited);
    for (let attempt = 0; attempt < 5; attempt += 1)
      assert.throws(() => auth.completeLogin(limited.challenge, 'invalid', 0, 'limited-2fa'));
    assert.throws(() => auth.beginLogin(process.env.ADMIN_PASSWORD!, 'limited-2fa'));
  } finally {
    rmSync(filename, { force: true });
  }
});

test('two-factor HTTP enrollment, trusted cookies, validation, expiry and revocation', async (context) => {
  const filename = path.join(sessionDirectory, 'two-factor.json');
  const previousSecure = settings.secureCookie;
  context.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  settings.secureCookie = true;
  const app = await createApp();
  const server = app.getHttpAdapter().getInstance();
  const password = process.env.ADMIN_PASSWORD!;
  const cookies = (response: { headers: { [key: string]: unknown } }) => {
    const values = response.headers['set-cookie'];
    return (Array.isArray(values) ? values : values ? [values] : []).map(String);
  };
  const post = (url: string, payload: object, cookie = '') =>
    server.inject({ method: 'POST', url: `/api/auth/${url}`, payload, headers: { cookie } });
  try {
    assert.equal((await post('two-factor/setup', { password })).statusCode, 401);
    const first = await post('login', { password });
    const firstCookie = cookies(first)[0].split(';')[0];
    assert.equal((await post('two-factor/setup', { password: 'wrong' }, firstCookie)).statusCode, 400);
    const setupResponse = await post('two-factor/setup', { password }, firstCookie);
    assert.equal(setupResponse.statusCode, 201);
    assert.equal(setupResponse.headers['cache-control'], 'no-store');
    const setup = setupResponse.json();
    assert.match(setup.qrCode, /^data:image\/png;base64,/);
    assert.match(setup.uri, /^otpauth:\/\/totp\//);
    const totp = new TOTP({ secret: setup.secret });
    const enabled = await post('two-factor/enable', { code: totp.generate() }, firstCookie);
    assert.equal(enabled.statusCode, 201);
    const recoveryCodes: string[] = enabled.json().recoveryCodes;
    const challengeResponse = await post('login', { password });
    const challenge = challengeResponse.json().challenge;
    assert.equal(challengeResponse.json().requiresTwoFactor, true);
    assert.equal(challengeResponse.headers['set-cookie'], undefined);
    assert.equal(
      (await server.inject({ url: '/api/auth/session', headers: { cookie: firstCookie } })).statusCode,
      200,
    );
    assert.equal((await post('verify', { challenge, code: '000000' })).statusCode, 401);
    assert.equal(
      (await server.inject({ url: '/api/auth/session', headers: { cookie: firstCookie } })).statusCode,
      200,
    );
    for (const rememberDays of [-1, 91, 1.5, '7', null])
      assert.equal(
        (await post('verify', { challenge, code: recoveryCodes[0], rememberDays })).statusCode,
        400,
      );
    const verified = await post('verify', { challenge, code: recoveryCodes[0], rememberDays: 7 });
    assert.equal(verified.statusCode, 201);
    const sessionCookie = cookies(verified)
      .find((value) => value.startsWith('adb_session='))!
      .split(';')[0];
    const trustHeader = cookies(verified).find((value) => value.startsWith('adb_trusted_browser='))!;
    const trustedCookie = trustHeader.split(';')[0];
    assert.match(trustHeader, /Max-Age=604800/);
    assert.match(trustHeader, /HttpOnly/);
    assert.match(trustHeader, /Secure/);
    assert.match(trustHeader, /SameSite=Strict/);
    assert.match(trustHeader, /Path=\/api\/auth/);
    assert.equal(
      (await server.inject({ url: '/api/auth/session', headers: { cookie: firstCookie } })).statusCode,
      401,
    );
    assert.equal((await post('verify', { challenge, code: recoveryCodes[1] })).statusCode, 401);
    const security = await server.inject({
      url: '/api/auth/two-factor',
      headers: { cookie: `${sessionCookie}; ${trustedCookie}` },
    });
    assert.equal(security.json().trustedBrowsers, 1);
    assert.equal(security.json().recoveryCodesRemaining, 9);
    assert.ok(!security.body.includes(setup.secret));
    assert.equal((await post('two-factor/disable', { password }, sessionCookie)).statusCode, 400);
    assert.equal((await post('logout', {}, sessionCookie)).statusCode, 201);
    const remembered = await post('login', { password }, trustedCookie);
    assert.equal(remembered.statusCode, 201);
    assert.equal(remembered.json().requiresTwoFactor, undefined);
    assert.equal(
      cookies(remembered).some((value) => value.startsWith('adb_trusted_browser=')),
      false,
    );
    assert.equal((await post('login', { password: 'wrong' }, trustedCookie)).statusCode, 401);
    const currentCookie = cookies(remembered)[0].split(';')[0];
    const revoked = await post(
      'two-factor/revoke-trusted',
      { password, code: recoveryCodes[1] },
      currentCookie,
    );
    assert.equal(revoked.statusCode, 201);
    const untrusted = await post('login', { password }, trustedCookie);
    assert.equal(untrusted.json().requiresTwoFactor, true);
    const newTrust = await post('verify', {
      challenge: untrusted.json().challenge,
      code: recoveryCodes[2],
      rememberDays: 1,
    });
    assert.equal(newTrust.statusCode, 201);
    const expiredTrust = cookies(newTrust)
      .find((value) => value.startsWith('adb_trusted_browser='))!
      .split(';')[0];
    context.mock.timers.tick(86_400_000);
    const expired = await post('login', { password }, expiredTrust);
    assert.equal(expired.json().requiresTwoFactor, true);
    const noTrust = await post('verify', { challenge: expired.json().challenge, code: totp.generate() });
    assert.equal(noTrust.statusCode, 201);
    assert.match(
      cookies(noTrust).find((value) => value.startsWith('adb_trusted_browser='))!,
      /Max-Age=0/,
    );
    const finalCookie = cookies(noTrust)
      .find((value) => value.startsWith('adb_session='))!
      .split(';')[0];
    assert.equal(
      (await post('two-factor/disable', { password, code: recoveryCodes[3] }, finalCookie)).statusCode,
      201,
    );
    assert.equal(new TwoFactorService().enabled, false);
    assert.equal((await post('login', { password })).json().requiresTwoFactor, undefined);
  } finally {
    await app.close();
    settings.secureCookie = previousSecure;
    rmSync(filename, { force: true });
  }
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

test('upgrading a multi-session store keeps only the latest login across restarts', () => {
  const auth = new AuthService();
  const first = auth.login(process.env.ADMIN_PASSWORD!, 'legacy-first');
  const firstEntries = JSON.parse(readFileSync(settings.sessionFile, 'utf8'));
  const second = auth.login(process.env.ADMIN_PASSWORD!, 'legacy-last');
  const secondEntries = JSON.parse(readFileSync(settings.sessionFile, 'utf8'));
  writeFileSync(settings.sessionFile, JSON.stringify([...firstEntries, ...secondEntries]));
  const restored = new AuthService();
  assert.equal(restored.find(first.token), undefined);
  assert.deepEqual(restored.find(second.token), second.session);
  assert.equal(JSON.parse(readFileSync(settings.sessionFile, 'utf8')).length, 1);
  assert.equal(new AuthService().find(first.token), undefined);
  assert.deepEqual(new AuthService().find(second.token), second.session);
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
  const streams = new StreamService(adb, { isActive: () => true } as unknown as AuthService);
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

test('stream HTTP defaults and limits protect capacity while allowing owner replacement', async (context) => {
  const previous = {
    streamMaxSize: settings.streamMaxSize,
    streamMaxFps: settings.streamMaxFps,
    streamBitRate: settings.streamBitRate,
    streamMaxSessions: settings.streamMaxSessions,
  };
  Object.assign(settings, {
    streamMaxSize: 1024,
    streamMaxFps: 20,
    streamBitRate: 2_000_000,
    streamMaxSessions: 2,
  });
  const app = await createApp();
  const launches: string[][] = [];
  try {
    const adb = app.get(AdbService);
    context.mock.method(adb, 'ready', async () => {});
    context.mock.method(adb, 'size', async () => ({ width: 1080, height: 2400 }));
    context.mock.method(adb, 'run', async () => {});
    context.mock.method(adb, 'text', async () => '27190');
    context.mock.method(adb, 'spawn', (_serial: string, args: string[]) => {
      launches.push(args);
      return Object.assign(new EventEmitter(), { kill() {} });
    });
    const server = app.getHttpAdapter().getInstance();
    const auth = app.get(AuthService);
    const owners = new Map(
      Array.from({ length: 3 }, (_, index) => [
        `isolated-token-${index}`,
        { id: `isolated-owner-${index}`, expiresAt: Date.now() + 60_000 },
      ]),
    );
    context.mock.method(auth, 'find', (token?: string) => owners.get(token || ''));
    context.mock.method(auth, 'isActive', (id: string) =>
      [...owners.values()].some((owner) => owner.id === id),
    );
    const headers = [...owners.keys()].map((token) => ({ cookie: `adb_session=${token}` }));
    assert.equal(
      (await server.inject({ method: 'POST', url: '/api/streams', payload: { serial: 'abc' } })).statusCode,
      401,
    );
    const first = await server.inject({
      method: 'POST',
      url: '/api/streams',
      headers: headers[0],
      payload: { serial: 'abc' },
    });
    assert.equal(first.statusCode, 201);
    assert.deepEqual(first.json().options, { maxSize: 1024, maxFps: 20, bitRate: 2_000_000 });
    assert.ok(launches[0].includes('max_size=1024'));
    assert.ok(launches[0].includes('max_fps=20'));
    assert.ok(launches[0].includes('video_bit_rate=2000000'));
    const second = await server.inject({
      method: 'POST',
      url: '/api/streams',
      headers: headers[1],
      payload: { serial: 'def', maxSize: 1920, maxFps: 60, bitRate: 12_000_000 },
    });
    assert.equal(second.statusCode, 201);
    assert.deepEqual(second.json().options, first.json().options);
    const rejected = await server.inject({
      method: 'POST',
      url: '/api/streams',
      headers: headers[2],
      payload: { serial: 'ghi' },
    });
    assert.equal(rejected.statusCode, 409);
    assert.match(rejected.json().message, /上限/);
    assert.equal(launches.length, 2);
    const invalid = await server.inject({
      method: 'POST',
      url: '/api/streams',
      headers: headers[0],
      payload: { serial: 'xyz', bitRate: 0 },
    });
    assert.equal(invalid.statusCode, 400);
    assert.ok(app.get(StreamService).get(first.json().id));
    const replaced = await server.inject({
      method: 'POST',
      url: '/api/streams',
      headers: headers[0],
      payload: { serial: 'xyz', maxSize: 800, maxFps: 15, bitRate: 1_000_000 },
    });
    assert.equal(replaced.statusCode, 201);
    assert.deepEqual(replaced.json().options, { maxSize: 800, maxFps: 15, bitRate: 1_000_000 });
    assert.equal(app.get(StreamService).get(first.json().id), undefined);
    assert.ok(app.get(StreamService).get(second.json().id));
    const release = await server.inject({
      method: 'DELETE',
      url: `/api/streams/${second.json().id}`,
      headers: headers[1],
    });
    assert.equal(release.statusCode, 200);
    const admitted = await server.inject({
      method: 'POST',
      url: '/api/streams',
      headers: headers[2],
      payload: { serial: 'ghi' },
    });
    assert.equal(admitted.statusCode, 201);
  } finally {
    await app.close();
    Object.assign(settings, previous);
  }
});

for (const twoFactor of [false, true]) {
  test(`login takeover revokes the old cookie, closes its WebSocket and releases the device (2FA=${twoFactor})`, async (context) => {
    const app = await createApp();
    const commands: string[][] = [];
    let killed = 0;
    let viewer: WebSocket | undefined;
    try {
      const adb = app.get(AdbService);
      context.mock.method(adb, 'ready', async () => {});
      context.mock.method(adb, 'size', async () => ({ width: 1080, height: 2400 }));
      context.mock.method(adb, 'run', async (args: string[]) => {
        commands.push(args);
      });
      context.mock.method(adb, 'text', async () => '27190');
      context.mock.method(adb, 'spawn', () =>
        Object.assign(new EventEmitter(), {
          kill() {
            killed += 1;
          },
        }),
      );
      await app.listen({ host: '127.0.0.1', port: 0 });
      const origin = await app.getUrl();
      const server = app.getHttpAdapter().getInstance();
      const login = () =>
        server.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { password: process.env.ADMIN_PASSWORD! },
        });
      const first = await login();
      assert.equal(first.statusCode, 201);
      const oldHeaders = { cookie: String(first.headers['set-cookie']).split(';')[0] };
      let recoveryCode = '';
      if (twoFactor) {
        const factor = app.get(TwoFactorService);
        const session = app.get(AuthService).find(oldHeaders.cookie.slice('adb_session='.length))!;
        const setup = factor.begin(session.id);
        recoveryCode = factor.enable(session.id, new TOTP({ secret: setup.secret }).generate())
          .recoveryCodes[0];
      }
      const started = await server.inject({
        method: 'POST',
        url: '/api/streams',
        headers: oldHeaders,
        payload: { serial: 'abc' },
      });
      assert.equal(started.statusCode, 201);
      const oldStream = app.get(StreamService).get(started.json().id)!;
      viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/streams/${oldStream.id}`, {
        headers: oldHeaders,
        origin,
      });
      await once(viewer, 'open');
      const closed = once(viewer, 'close');
      const failed = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrong' },
      });
      assert.equal(failed.statusCode, 401);
      assert.equal(viewer.readyState, WebSocket.OPEN);
      assert.equal((await server.inject({ url: '/api/auth/session', headers: oldHeaders })).statusCode, 200);
      let second = await login();
      if (twoFactor) {
        const challenge = second.json().challenge;
        assert.equal(second.json().requiresTwoFactor, true);
        assert.equal(second.headers['set-cookie'], undefined);
        assert.equal(
          (
            await server.inject({
              method: 'POST',
              url: '/api/auth/verify',
              payload: { challenge, code: 'invalid' },
            })
          ).statusCode,
          401,
        );
        assert.equal(viewer.readyState, WebSocket.OPEN);
        assert.equal(killed, 0);
        assert.equal(app.get(StreamService).get(oldStream.id), oldStream);
        assert.equal(
          (await server.inject({ url: '/api/auth/session', headers: oldHeaders })).statusCode,
          200,
        );
        second = await server.inject({
          method: 'POST',
          url: '/api/auth/verify',
          payload: { challenge, code: recoveryCode },
        });
      }
      assert.equal(second.statusCode, 201);
      const newHeaders = { cookie: String(second.headers['set-cookie']).split(';')[0] };
      const [closeCode, closeReason] = await closed;
      assert.equal(closeCode, 4001);
      assert.equal(closeReason.toString(), 'session replaced');
      assert.equal(killed, 1);
      assert.equal(oldStream.clients.size, 0);
      assert.equal(app.get(StreamService).get(oldStream.id), undefined);
      assert.ok(commands.some((args) => args.join(' ') === 'forward --remove tcp:27190'));
      assert.ok(commands.every((args) => args[0] !== 'disconnect'));
      assert.equal((await server.inject({ url: '/api/auth/session', headers: oldHeaders })).statusCode, 401);
      assert.equal(
        (await server.inject({ method: 'POST', url: '/api/auth/logout', headers: oldHeaders })).statusCode,
        401,
      );
      assert.equal(
        (
          await server.inject({
            method: 'POST',
            url: '/api/streams',
            headers: oldHeaders,
            payload: { serial: 'abc' },
          })
        ).statusCode,
        401,
      );
      assert.equal((await server.inject({ url: '/api/auth/session', headers: newHeaders })).statusCode, 200);
      const replacement = await server.inject({
        method: 'POST',
        url: '/api/streams',
        headers: newHeaders,
        payload: { serial: 'abc' },
      });
      assert.equal(replacement.statusCode, 201);
      assert.notEqual(replacement.json().id, oldStream.id);
    } finally {
      viewer?.terminate();
      await app.close();
      if (twoFactor) rmSync(path.join(sessionDirectory, 'two-factor.json'), { force: true });
    }
  });
}

test('concurrent logins wait for startup cleanup and reject queued requests from replaced sessions', async (context) => {
  const app = await createApp();
  const events = new EventEmitter();
  const commands: string[][] = [];
  let finishForward!: (value: string) => void;
  let launches = 0;
  try {
    const adb = app.get(AdbService);
    context.mock.method(adb, 'ready', async () => {});
    context.mock.method(adb, 'size', async () => ({ width: 1080, height: 2400 }));
    context.mock.method(adb, 'run', async (args: string[]) => {
      commands.push(args);
    });
    context.mock.method(
      adb,
      'text',
      () =>
        new Promise<string>((resolve) => {
          finishForward = resolve;
          events.emit('forward');
        }),
    );
    context.mock.method(adb, 'spawn', () => {
      launches += 1;
      return Object.assign(new EventEmitter(), { kill() {} });
    });
    const auth = app.get(AuthService);
    const streams = app.get(StreamService);
    const old = auth.login(process.env.ADMIN_PASSWORD!, 'startup-owner');
    const forwarding = once(events, 'forward');
    const starting = assert.rejects(streams.start('abc', old.session.id), /取消|失效/);
    await forwarding;
    const queued = assert.rejects(streams.start('abc', old.session.id), /失效/);
    const originalStop = streams.stopInactive.bind(streams);
    context.mock.method(streams, 'stopInactive', () => {
      const pending = originalStop();
      events.emit('takeover');
      return pending;
    });
    const server = app.getHttpAdapter().getInstance();
    let completed = 0;
    const login = () =>
      server
        .inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { password: process.env.ADMIN_PASSWORD! },
        })
        .then((response) => {
          completed += 1;
          return response;
        });
    const replacing = once(events, 'takeover');
    const firstLogin = login();
    await replacing;
    const replacingAgain = once(events, 'takeover');
    const lastLogin = login();
    await replacingAgain;
    assert.equal(completed, 0);
    assert.equal(auth.isActive(old.session.id), false);
    finishForward('27190');
    const [firstResponse, lastResponse] = await Promise.all([firstLogin, lastLogin]);
    await Promise.all([starting, queued]);
    assert.equal(firstResponse.statusCode, 401);
    assert.equal(firstResponse.headers['set-cookie'], undefined);
    assert.equal(lastResponse.statusCode, 201);
    assert.equal(launches, 0);
    assert.equal(streams.list(old.session.id).length, 0);
    assert.ok(commands.some((args) => args.join(' ') === 'forward --remove tcp:27190'));
    context.mock.method(adb, 'text', async () => '27191');
    const headers = { cookie: String(lastResponse.headers['set-cookie']).split(';')[0] };
    assert.equal(
      (await server.inject({ method: 'POST', url: '/api/streams', headers, payload: { serial: 'abc' } }))
        .statusCode,
      201,
    );
    assert.equal(launches, 1);
  } finally {
    finishForward?.('27190');
    await app.close();
  }
});

test('stream heartbeat retains responsive viewers and cleans up silent connections', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let pings = 0;
  let terminated = 0;
  const session = new StreamSession('abc', 'owner', {} as AdbService, {
    maxSize: 1280,
    maxFps: 30,
    bitRate: 3_000_000,
  });
  const viewer = Object.assign(new EventEmitter(), {
    readyState: 1,
    ping: () => {
      pings += 1;
    },
    terminate: () => {
      terminated += 1;
    },
  });
  try {
    session.attach(viewer as unknown as WebSocket);
    for (let interval = 0; interval < 3; interval += 1) {
      context.mock.timers.tick(15_000);
      viewer.emit('pong');
      assert.equal(session.summary().started, true);
    }
    assert.equal(pings, 3);
    context.mock.timers.tick(15_000);
    assert.equal(pings, 4);
    context.mock.timers.tick(15_000);
    assert.equal(session.summary().started, false);
    assert.equal(session.clients.size, 0);
    assert.equal(terminated, 1);
    context.mock.timers.tick(60_000);
    assert.equal(pings, 4);
    assert.equal(terminated, 1);
  } finally {
    await session.stop('test cleanup');
  }
});

test('stopping during stream startup cleans up a late ADB forward without spawning scrcpy', async () => {
  const commands: string[][] = [];
  let completeForward!: (port: string) => void;
  let forwarding!: () => void;
  const forwardStarted = new Promise<void>((resolve) => {
    forwarding = resolve;
  });
  let spawned = false;
  const adb = {
    ready: async () => {},
    size: async () => ({ width: 1080, height: 2400 }),
    run: async (args: string[]) => {
      commands.push(args);
    },
    text: () =>
      new Promise<string>((resolve) => {
        completeForward = resolve;
        forwarding();
      }),
    spawn: () => {
      spawned = true;
      return Object.assign(new EventEmitter(), { kill() {} });
    },
  } as unknown as AdbService;
  const session = new StreamSession('abc', 'owner', adb, {
    maxSize: 1280,
    maxFps: 30,
    bitRate: 4_000_000,
  });
  const pending = session.start();
  await forwardStarted;
  await session.stop('manual');
  completeForward('27190');
  await assert.rejects(pending, /取消/);
  assert.equal(spawned, false);
  assert.ok(commands.some((args) => args.join(' ') === 'forward --remove tcp:27190'));
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

for (const slowViewer of [false, true])
  test(
    `video handshake, touch and ${slowViewer ? 'backpressure' : 'disconnect'} cleanup`,
    { timeout: 8000 },
    async () => {
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
      const streams = new StreamService(adb, { isActive: () => true } as unknown as AuthService);
      const viewerServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await once(viewerServer, 'listening');
      let viewer: WebSocket | undefined;
      let attachedViewer: WebSocket | undefined;
      try {
        const session = await streams.start('abc', 'owner', {
          maxSize: 1280,
          maxFps: 30,
          bitRate: 4_000_000,
        });
        viewerServer.on('connection', (client) => {
          attachedViewer = client;
          session.attach(client);
        });
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
        if (slowViewer) {
          Object.defineProperty(attachedViewer, 'bufferedAmount', {
            get: () => Math.max(256 * 1024, (session.summary().options.bitRate / 8) * 2),
          });
          const closed = once(viewer, 'close');
          connections[0].write(Buffer.from([0, 0, 0, 1, 0x65]));
          await closed;
          assert.equal(streams.get(session.id), undefined);
        } else viewer.close();
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
    },
  );
