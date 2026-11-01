import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, scryptSync } from 'node:crypto';
import { TOTP } from 'otpauth';
import { settings } from './config';
import { emptyFactor, StorageService } from './storage';
import { AuthService } from './auth';
import { TwoFactorService } from './two-factor';
import { DeviceRecordsService } from './devices';
import { StreamService } from './stream';
import { createApp } from './main';

process.env.ADMIN_PASSWORD = 'isolated-sqlite-test-password';

function temporaryStore() {
  const directory = mkdtempSync(path.join(tmpdir(), 'adb-storage-'));
  const previous = { dataDir: settings.dataDir, databaseFile: settings.databaseFile };
  settings.dataDir = directory;
  settings.databaseFile = path.join(directory, 'adb-desk.sqlite');
  return {
    directory,
    cleanup() {
      Object.assign(settings, previous);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('SQLite migration is atomic, retryable and never reimports legacy files', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'adb-sqlite-'));
  const previous = settings.databaseFile;
  settings.databaseFile = path.join(directory, 'adb-desk.sqlite');
  try {
    const device = { serial: 'abc', model: 'Phone', transport: 'usb', lastConnectedAt: 1 };
    const legacy = JSON.stringify([device]);
    writeFileSync(path.join(directory, 'devices.json'), legacy);
    writeFileSync(path.join(directory, 'two-factor.json'), '{}');
    assert.throws(() => new StorageService(), /Invalid two-factor/);
    const failed = new DatabaseSync(settings.databaseFile);
    try {
      assert.equal(failed.prepare('PRAGMA user_version').get()!.user_version, 0);
      assert.equal(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'devices'").get(), undefined);
    } finally {
      failed.close();
    }
    rmSync(path.join(directory, 'two-factor.json'));
    const store = new StorageService();
    assert.deepEqual(
      store.read((database) => ({ ...database.prepare('SELECT * FROM devices').get()! })),
      { ...device, note: '' },
    );
    assert.equal(readFileSync(path.join(directory, 'devices.json'), 'utf8'), legacy);
    assert.throws(() =>
      store.transaction((database) => {
        database.exec('DELETE FROM devices');
        throw new Error('simulated transaction failure');
      }),
    );
    assert.equal(
      store.read((database) => database.prepare('SELECT count(*) AS total FROM devices').get()!.total),
      1,
    );
    store.transaction((database) => database.exec('DELETE FROM devices'));
    const reopened = new StorageService();
    assert.equal(
      reopened.read((database) => database.prepare('SELECT count(*) AS total FROM devices').get()!.total),
      0,
    );
    assert.equal(reopened.factor().secret, '');
  } finally {
    settings.databaseFile = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration preserves the last active session, TOTP, recovery codes and trusted browsers', () => {
  const temporary = temporaryStore();
  try {
    const sessionKey = scryptSync(process.env.ADMIN_PASSWORD!, 'adb-session-store-v1', 32);
    const factorKey = scryptSync(process.env.ADMIN_PASSWORD!, 'adb-two-factor-v1', 32);
    const sessionHash = (token: string) => createHmac('sha256', sessionKey).update(token).digest('hex');
    const factorHash = (token: string) => createHmac('sha256', factorKey).update(token).digest('hex');
    const session = { id: 'b'.repeat(32), expiresAt: Date.now() + 60_000 };
    const recovery = 'a'.repeat(20);
    const factor = {
      ...emptyFactor(),
      secret: 'A'.repeat(32),
      recovery: [factorHash(recovery)],
      trusted: [{ hash: factorHash('trusted-token'), expiresAt: session.expiresAt }],
    };
    writeFileSync(
      path.join(temporary.directory, 'sessions.json'),
      JSON.stringify([
        [sessionHash('older'), { ...session, id: 'a'.repeat(32) }],
        [sessionHash('latest'), session],
        [sessionHash('expired'), { ...session, id: 'c'.repeat(32), expiresAt: 0 }],
      ]),
    );
    writeFileSync(path.join(temporary.directory, 'two-factor.json'), JSON.stringify(factor));
    const auth = new AuthService();
    assert.equal(auth.find('older'), undefined);
    assert.equal(auth.find('expired'), undefined);
    assert.deepEqual(auth.find('latest'), session);
    const security = new TwoFactorService();
    assert.equal(security.enabled, true);
    assert.equal(security.isTrusted('trusted-token'), true);
    assert.equal(security.verify(recovery), true);
    assert.equal(new TwoFactorService().verify(recovery), false);
    assert.equal(security.verify(new TOTP({ secret: factor.secret }).generate()), true);
    auth.revoke('latest');
    assert.equal(new AuthService().find('latest'), undefined);
  } finally {
    temporary.cleanup();
  }
});

test('SQLite write failures preserve session and device state and permit retries', () => {
  const temporary = temporaryStore();
  try {
    const store = new StorageService();
    const auth = new AuthService(new TwoFactorService(store), store);
    const first = auth.login(process.env.ADMIN_PASSWORD!, 'local');
    const devices = new DeviceRecordsService(store);
    devices.remember('abc');
    const before = devices.list();
    store.transaction((database) =>
      database.exec(`
      CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
      CREATE TRIGGER fail_devices BEFORE UPDATE ON devices BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
    `),
    );
    assert.throws(() => auth.login(process.env.ADMIN_PASSWORD!, 'local'), /simulated/);
    assert.deepEqual(auth.find(first.token), first.session);
    assert.deepEqual(new AuthService().find(first.token), first.session);
    assert.throws(() => devices.updateNote('abc', 'unsaved'), /simulated/);
    assert.deepEqual(devices.list(), before);
    assert.deepEqual(new DeviceRecordsService().list(), before);
    assert.throws(() => devices.remember('abc'), /simulated/);
    assert.throws(
      () => devices.observe([{ serial: 'abc', state: 'device', model: 'Changed', transport: 'usb' }]),
      /simulated/,
    );
    assert.deepEqual(devices.list(), before);
    store.transaction((database) => database.exec('DROP TRIGGER fail_devices; DROP TRIGGER fail_session;'));
    devices.observe([{ serial: 'abc', state: 'device', model: 'Changed', transport: 'usb' }]);
    devices.updateNote('abc', 'saved');
    assert.equal(new DeviceRecordsService().list()[0].note, 'saved');
    assert.equal(devices.list()[0].model, 'Changed');
    store.transaction((database) =>
      database.exec(
        "CREATE TRIGGER fail_delete BEFORE DELETE ON devices BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
      ),
    );
    assert.throws(() => devices.remove('abc'), /simulated/);
    assert.equal(devices.list().length, 1);
    store.transaction((database) => database.exec('DROP TRIGGER fail_delete'));
    devices.remove('abc');
    assert.deepEqual(new DeviceRecordsService().list(), []);
  } finally {
    temporary.cleanup();
  }
});

test('failed two-factor login rolls back recovery consumption, trust and session replacement', () => {
  const temporary = temporaryStore();
  try {
    const store = new StorageService();
    const factor = new TwoFactorService(store);
    const auth = new AuthService(factor, store);
    const first = auth.login(process.env.ADMIN_PASSWORD!, 'first');
    const setup = factor.begin(first.session.id);
    const { recoveryCodes } = factor.enable(first.session.id, new TOTP({ secret: setup.secret }).generate());
    const challenge = auth.beginLogin(process.env.ADMIN_PASSWORD!, 'next');
    assert.ok('challenge' in challenge);
    store.transaction((database) =>
      database.exec(
        "CREATE TRIGGER fail_login BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
      ),
    );
    assert.throws(() => auth.completeLogin(challenge.challenge, recoveryCodes[0], 7, 'next'), /simulated/);
    assert.equal(factor.status().recoveryCodesRemaining, 10);
    assert.equal(factor.status().trustedBrowsers, 0);
    assert.deepEqual(new AuthService().find(first.token), first.session);
    store.transaction((database) => database.exec('DROP TRIGGER fail_login'));
    const result = auth.completeLogin(challenge.challenge, recoveryCodes[0], 7, 'next');
    assert.equal(factor.status().recoveryCodesRemaining, 9);
    assert.equal(factor.isTrusted(result.trusted!.token), true);
    assert.equal(auth.find(first.token), undefined);
    assert.deepEqual(new AuthService().find(result.token), result.session);
  } finally {
    temporary.cleanup();
  }
});

test('failed HTTP logout still stops streams, preserves a retryable session and never reports success', async (context) => {
  const temporary = temporaryStore();
  const app = await createApp(path.join(temporary.directory, 'absent-web'));
  try {
    app.useLogger(false);
    const server = app.getHttpAdapter().getInstance();
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: process.env.ADMIN_PASSWORD },
    });
    assert.equal(login.statusCode, 201);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const token = cookie.slice('adb_session='.length);
    const session = app.get(AuthService).find(token)!;
    const stopped: string[] = [];
    context.mock.method(app.get(StreamService), 'stopForAuth', async (id: string) => {
      stopped.push(id);
    });
    const store = app.get(StorageService);
    store.transaction((database) =>
      database.exec(
        "CREATE TRIGGER fail_logout BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
      ),
    );
    const failed = await server.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.headers['set-cookie'], undefined);
    assert.deepEqual(stopped, [session.id]);
    assert.deepEqual(app.get(AuthService).find(token), session);
    assert.deepEqual(new AuthService().find(token), session);
    store.transaction((database) => database.exec('DROP TRIGGER fail_logout'));
    const retried = await server.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    assert.equal(retried.statusCode, 201);
    assert.match(String(retried.headers['set-cookie']), /Max-Age=0/);
    assert.equal(new AuthService().find(token), undefined);
    assert.equal((await server.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode, 401);
  } finally {
    await app.close();
    temporary.cleanup();
  }
});
