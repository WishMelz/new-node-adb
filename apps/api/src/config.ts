import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

export const root = path.resolve(__dirname, '../../..');
loadEnv({ path: path.join(root, '.env'), quiet: true });

export function parseSettings(environment: NodeJS.ProcessEnv) {
  function integer(name: string, fallback: number, minimum: number, maximum: number) {
    const value = Number(environment[name] || fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  }
  const origin = environment.PUBLIC_ORIGIN || '';
  if (origin) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials');
    }
  }
  const secureCookie = environment.COOKIE_SECURE || 'false';
  if (!['true', 'false'].includes(secureCookie)) throw new Error('COOKIE_SECURE must be true or false');
  if (origin && origin.startsWith('https:') !== (secureCookie === 'true')) {
    throw new Error('COOKIE_SECURE must match the PUBLIC_ORIGIN protocol');
  }
  return {
    host: environment.HOST || '127.0.0.1',
    port: integer('PORT', 23110, 1, 65535),
    origin,
    secureCookie: secureCookie === 'true',
    sessionHours: integer('SESSION_HOURS', 24, 24, 8760),
    loginMaxAttempts: integer('LOGIN_MAX_ATTEMPTS', 5, 1, 100),
    loginWindowMinutes: integer('LOGIN_WINDOW_MINUTES', 15, 1, 1440),
    streamMaxSize: integer('STREAM_MAX_SIZE', 1280, 480, 1920),
    streamMaxFps: integer('STREAM_MAX_FPS', 30, 10, 60),
    streamBitRate: integer('STREAM_BIT_RATE', 3_000_000, 500_000, 12_000_000),
    streamMaxSessions: integer('STREAM_MAX_SESSIONS', 2, 1, 16),
  };
}

export const settings = {
  ...parseSettings(process.env),
  sessionFile: path.join(root, '.data/sessions.json'),
  deviceRecordsFile: path.join(root, '.data/devices.json'),
  adbPath: process.env.ADB_PATH || 'adb',
  scrcpyVersion: process.env.SCRCPY_VERSION || '4.0',
  scrcpyPath: process.env.SCRCPY_SERVER_PATH || path.join(root, 'vendor/scrcpy-server-v4.0'),
};

export function loadPassword(): string {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const directory = path.join(root, '.data');
  const filename = path.join(directory, 'bootstrap-password');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(filename))
    writeFileSync(filename, randomBytes(24).toString('base64url'), { flag: 'wx', mode: 0o600 });
  const password = readFileSync(filename, 'utf8').trim();
  if (!password) throw new Error('Invalid bootstrap password: must not be empty');
  return password;
}
