import { Injectable, Module } from '@nestjs/common';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { settings } from './config';

export interface StoredDevice {
  serial: string;
  model: string;
  transport: 'network' | 'usb';
  lastConnectedAt: number;
  note: string;
}

export interface FactorState {
  version: string;
  secret: string;
  lastStep: number;
  recovery: string[];
  trusted: { hash: string; expiresAt: number }[];
}

export interface AdminAccount {
  passwordSalt: string;
  passwordHash: string;
  createdAt: number;
}

export function emptyFactor(): FactorState {
  return { version: randomBytes(16).toString('hex'), secret: '', lastStep: -1, recovery: [], trusted: [] };
}

export function validateFactor(value: unknown): FactorState {
  const state = value as FactorState | null;
  const digest = (item: unknown) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  if (
    !state ||
    typeof state.version !== 'string' ||
    !/^[a-f0-9]{32}$/.test(state.version) ||
    typeof state.secret !== 'string' ||
    (state.secret !== '' && !/^[A-Z2-7]{32}$/.test(state.secret)) ||
    !Number.isSafeInteger(state.lastStep) ||
    state.lastStep < -1 ||
    !Array.isArray(state.recovery) ||
    !state.recovery.every(digest) ||
    !Array.isArray(state.trusted) ||
    !state.trusted.every((entry) => entry && digest(entry.hash) && Number.isSafeInteger(entry.expiresAt))
  )
    throw new Error('Invalid two-factor store; restore a protected backup before restarting');
  return state;
}

@Injectable()
export class StorageService {
  readonly filename = settings.databaseFile;
  private active?: DatabaseSync;

  constructor() {
    mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(this.filename, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (process.platform !== 'win32') chmodSync(this.filename, 0o600);
    this.transaction((database) => {
      const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 2) throw new Error('Unsupported database version; upgrade the application');
      if (version === 1) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS admin_account (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            passwordSalt TEXT NOT NULL,
            passwordHash TEXT NOT NULL,
            createdAt INTEGER NOT NULL
          );
        `);
        database.exec('PRAGMA user_version = 2');
        return;
      }
      if (version === 2) return;
      database.exec(`
        CREATE TABLE sessions (
          tokenHash TEXT PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          expiresAt INTEGER NOT NULL
        );
        CREATE TABLE devices (
          serial TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          transport TEXT NOT NULL CHECK (transport IN ('network', 'usb')),
          lastConnectedAt INTEGER NOT NULL,
          note TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE two_factor (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state TEXT NOT NULL CHECK (json_valid(state))
        );
        CREATE TABLE admin_account (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          passwordSalt TEXT NOT NULL,
          passwordHash TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        );
      `);
      this.migrate(database);
      database.exec('PRAGMA user_version = 2');
    });
  }

  read<Result>(operation: (database: DatabaseSync) => Result): Result {
    if (this.active) return operation(this.active);
    const database = new DatabaseSync(this.filename);
    try {
      database.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
      return operation(database);
    } finally {
      database.close();
    }
  }

  transaction<Result>(operation: (database: DatabaseSync) => Result): Result {
    if (this.active) return operation(this.active);
    return this.read((database) => {
      database.exec('BEGIN IMMEDIATE');
      this.active = database;
      try {
        const result = operation(database);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {}
        throw error;
      } finally {
        this.active = undefined;
      }
    });
  }

  factor(): FactorState {
    return this.read((database) => {
      const row = database.prepare('SELECT state FROM two_factor WHERE singleton = 1').get();
      if (!row) throw new Error('Missing two-factor state; restore a protected database backup');
      return validateFactor(JSON.parse(String(row.state)));
    });
  }

  adminAccount(): AdminAccount | undefined {
    return this.read((database) => {
      const row = database
        .prepare('SELECT passwordSalt, passwordHash, createdAt FROM admin_account WHERE singleton = 1')
        .get();
      return row
        ? {
            passwordSalt: String(row.passwordSalt),
            passwordHash: String(row.passwordHash),
            createdAt: Number(row.createdAt),
          }
        : undefined;
    });
  }

  saveFactor(state: FactorState) {
    this.transaction((database) => {
      database.prepare('UPDATE two_factor SET state = ? WHERE singleton = 1').run(JSON.stringify(state));
    });
  }

  private migrate(database: DatabaseSync) {
    const directory = path.dirname(this.filename);
    const legacy = (name: string): unknown => {
      const filename = path.join(directory, name);
      return existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : undefined;
    };
    const sessions = legacy('sessions.json');
    if (sessions !== undefined) {
      if (!Array.isArray(sessions)) throw new Error('Invalid session store');
      for (const entry of sessions) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid session entry');
        const [hash, session] = entry;
        if (
          typeof hash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(hash) ||
          !session ||
          typeof session.id !== 'string' ||
          !/^[a-f0-9]{32}$/.test(session.id) ||
          !Number.isSafeInteger(session.expiresAt)
        )
          throw new Error('Invalid session entry');
        if (session.expiresAt > Date.now()) {
          database.exec('DELETE FROM sessions');
          database
            .prepare('INSERT INTO sessions (tokenHash, id, expiresAt) VALUES (?, ?, ?)')
            .run(hash, session.id, session.expiresAt);
        }
      }
    }
    const records = legacy('devices.json');
    if (records !== undefined) {
      if (!Array.isArray(records)) throw new Error('Invalid device records');
      for (const record of records) {
        if (
          !record ||
          typeof record.serial !== 'string' ||
          !/^[A-Za-z0-9_.:[\]%-]{1,160}$/.test(record.serial) ||
          typeof record.model !== 'string' ||
          !['network', 'usb'].includes(record.transport) ||
          !Number.isSafeInteger(record.lastConnectedAt) ||
          record.lastConnectedAt < 0 ||
          (record.note !== undefined && typeof record.note !== 'string') ||
          (typeof record.note === 'string' && [...record.note].length > 120)
        )
          throw new Error('Invalid device record');
        database
          .prepare('INSERT OR REPLACE INTO devices VALUES (?, ?, ?, ?, ?)')
          .run(record.serial, record.model, record.transport, record.lastConnectedAt, record.note ?? '');
      }
    }
    const factor = legacy('two-factor.json');
    database
      .prepare('INSERT INTO two_factor (singleton, state) VALUES (1, ?)')
      .run(JSON.stringify(factor === undefined ? emptyFactor() : validateFactor(factor)));
  }
}

@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
