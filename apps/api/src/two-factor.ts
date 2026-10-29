import { BadRequestException, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TOTP, Secret } from 'otpauth';
import { loadPassword, settings } from './config';

export const TRUST_COOKIE = 'adb_trusted_browser';
export const MAX_TRUST_DAYS = 90;
const DAY = 86_400_000;
interface FactorState {
  version: string;
  secret: string;
  lastStep: number;
  recovery: string[];
  trusted: { hash: string; expiresAt: number }[];
}

@Injectable()
export class TwoFactorService {
  private readonly filename = path.join(path.dirname(settings.sessionFile), 'two-factor.json');
  private readonly key = scryptSync(loadPassword(), 'adb-two-factor-v1', 32);
  private state: FactorState = {
    version: randomBytes(16).toString('hex'),
    secret: '',
    lastStep: -1,
    recovery: [],
    trusted: [],
  };
  private pending?: { secret: string; sessionId: string; expiresAt: number };

  constructor() {
    if (!existsSync(this.filename)) return;
    const state: FactorState = JSON.parse(readFileSync(this.filename, 'utf8'));
    const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (
      !state ||
      !/^[a-f0-9]{32}$/.test(state.version) ||
      typeof state.secret !== 'string' ||
      (state.secret !== '' && !/^[A-Z2-7]{32}$/.test(state.secret)) ||
      !Number.isSafeInteger(state.lastStep) ||
      state.lastStep < -1 ||
      !Array.isArray(state.recovery) ||
      !state.recovery.every(digest) ||
      !Array.isArray(state.trusted) ||
      !state.trusted.every((entry) => entry && digest(entry.hash) && Number.isSafeInteger(entry.expiresAt))
    ) {
      throw new Error('Invalid two-factor store; restore a protected backup before restarting');
    }
    this.state = state;
  }

  get enabled() {
    return !!this.state.secret;
  }
  get version() {
    return this.state.version;
  }
  status(token?: string) {
    const current = this.state.trusted.find(
      (entry) => entry.hash === this.hash(token || '') && entry.expiresAt > Date.now(),
    );
    return {
      enabled: this.enabled,
      maxTrustDays: MAX_TRUST_DAYS,
      trustedBrowsers: this.state.trusted.filter((entry) => entry.expiresAt > Date.now()).length,
      trustedUntil: current?.expiresAt ?? null,
      recoveryCodesRemaining: this.state.recovery.length,
    };
  }

  begin(sessionId: string) {
    if (this.enabled) throw new BadRequestException('双重验证已启用');
    const secret = new Secret({ size: 20 }).base32;
    this.pending = { secret, sessionId, expiresAt: Date.now() + 10 * 60_000 };
    return { secret, uri: this.totp(secret).toString(), expiresAt: this.pending.expiresAt };
  }

  enable(sessionId: string, code: string) {
    if (
      this.enabled ||
      !this.pending ||
      this.pending.sessionId !== sessionId ||
      this.pending.expiresAt <= Date.now()
    )
      throw new BadRequestException('绑定已失效，请重新开始');
    const step = this.step(this.pending.secret, code, -1);
    if (step === null) throw new BadRequestException('验证码不正确或已过期');
    const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(10).toString('hex'));
    this.persist({
      version: randomBytes(16).toString('hex'),
      secret: this.pending.secret,
      lastStep: step,
      recovery: recoveryCodes.map((code) => this.hash(code)),
      trusted: [],
    });
    this.pending = undefined;
    return { recoveryCodes };
  }

  verify(code: string) {
    if (!this.enabled) return false;
    const step = this.step(this.state.secret, code, this.state.lastStep);
    if (step !== null) {
      this.persist({ ...this.state, lastStep: step });
    } else {
      const index = this.state.recovery.indexOf(this.hash(code));
      if (!/^[a-f0-9]{20}$/.test(code) || index === -1) return false;
      this.persist({
        ...this.state,
        recovery: this.state.recovery.filter((_, position) => position !== index),
      });
    }
    return true;
  }

  isTrusted(token?: string) {
    return (
      this.enabled &&
      !!token &&
      this.state.trusted.some((entry) => entry.hash === this.hash(token) && entry.expiresAt > Date.now())
    );
  }

  remember(days: number) {
    if (!this.enabled || !Number.isInteger(days) || days < 1 || days > MAX_TRUST_DAYS)
      throw new BadRequestException('记忆天数必须为 1-90 天');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + days * DAY;
    const trusted = this.state.trusted.filter((entry) => entry.expiresAt > Date.now()).slice(-99);
    trusted.push({ hash: this.hash(token), expiresAt });
    this.persist({ ...this.state, trusted });
    return { token, expiresAt };
  }

  revokeTrusted() {
    this.persist({ ...this.state, trusted: [], version: randomBytes(16).toString('hex') });
  }

  disable() {
    this.persist({
      version: randomBytes(16).toString('hex'),
      secret: '',
      lastStep: -1,
      recovery: [],
      trusted: [],
    });
    this.pending = undefined;
  }

  private totp(secret: string) {
    return new TOTP({
      issuer: 'ADB Control Room',
      label: 'admin',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
  }
  private step(secret: string, code: string, lastStep: number) {
    if (!/^\d{6}$/.test(code)) return null;
    const now = Date.now();
    const delta = this.totp(secret).validate({ token: code, timestamp: now, window: 1 });
    const step = Math.floor(now / 30_000) + (delta ?? 0);
    return delta !== null && step > lastStep ? step : null;
  }
  private hash(value: string) {
    return createHmac('sha256', this.key).update(value).digest('hex');
  }
  private persist(next: FactorState) {
    mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.filename}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${this.filename}.tmp`, this.filename);
    this.state = next;
  }
}
