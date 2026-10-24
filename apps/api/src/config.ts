import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

export const root = path.resolve(__dirname, '../../..');
loadEnv({ path: path.join(root, '.env'), quiet: true });

const sessionHours = Number(process.env.SESSION_HOURS || 24);
if (!Number.isInteger(sessionHours) || sessionHours < 24) throw new Error('SESSION_HOURS must be an integer of at least 24');

export const settings = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 23110),
  origin: process.env.PUBLIC_ORIGIN || '',
  secureCookie: process.env.COOKIE_SECURE === 'true',
  sessionHours,
  sessionFile: path.join(root, '.data/sessions.json'),
  deviceRecordsFile: path.join(root, '.data/devices.json'),
  adbPath: process.env.ADB_PATH || 'adb',
  scrcpyVersion: process.env.SCRCPY_VERSION || '4.0',
  scrcpyPath: process.env.SCRCPY_SERVER_PATH || path.join(root, 'vendor/scrcpy-server-v4.0'),
};

export function loadPassword(): string {
  if (process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters');
    return process.env.ADMIN_PASSWORD;
  }
  const directory = path.join(root, '.data');
  const filename = path.join(directory, 'bootstrap-password');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(filename)) writeFileSync(filename, randomBytes(24).toString('base64url'), { flag: 'wx', mode: 0o600 });
  return readFileSync(filename, 'utf8').trim();
}