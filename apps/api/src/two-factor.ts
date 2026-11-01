import { BadRequestException, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { loadPassword } from './config';
import { FactorState, StorageService } from './storage';

export const TRUST_COOKIE = 'adb_trusted_browser';
export const MAX_TRUST_DAYS = 90;
const DAY = 86_400_000;

@Injectable()
export class TwoFactorService {
  private readonly key = scryptSync(loadPassword(), 'adb-two-factor-v1', 32);
  private pending?: { secret: string; sessionId: string; expiresAt: number };

  constructor(readonly store: StorageService = new StorageService()) {}

  private get state() {
    return this.store.factor();
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
    const result = this.store.transaction(() => {
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
      return { recoveryCodes };
    });
    this.pending = undefined;
    return result;
  }

  verify(code: string) {
    return this.store.transaction(() => {
      const state = this.state;
      if (!state.secret) return false;
      const step = this.step(state.secret, code, state.lastStep);
      if (step !== null) {
        this.persist({ ...state, lastStep: step });
      } else {
        const index = state.recovery.indexOf(this.hash(code));
        if (!/^[a-f0-9]{20}$/.test(code) || index === -1) return false;
        this.persist({
          ...state,
          recovery: state.recovery.filter((_, position) => position !== index),
        });
      }
      return true;
    });
  }

  isTrusted(token?: string) {
    return (
      this.enabled &&
      !!token &&
      this.state.trusted.some((entry) => entry.hash === this.hash(token) && entry.expiresAt > Date.now())
    );
  }

  remember(days: number) {
    return this.store.transaction(() => {
      if (!this.enabled || !Number.isInteger(days) || days < 1 || days > MAX_TRUST_DAYS)
        throw new BadRequestException('记忆天数必须为 1-90 天');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + days * DAY;
      const trusted = this.state.trusted.filter((entry) => entry.expiresAt > Date.now()).slice(-99);
      trusted.push({ hash: this.hash(token), expiresAt });
      this.persist({ ...this.state, trusted });
      return { token, expiresAt };
    });
  }

  revokeTrusted() {
    this.store.transaction(() => {
      this.persist({ ...this.state, trusted: [], version: randomBytes(16).toString('hex') });
    });
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
      issuer: 'ADB Desk',
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
    this.store.saveFactor(next);
  }
}
