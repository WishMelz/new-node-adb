import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  Req,
  UnauthorizedException,
  UseGuards,
  HttpException,
  HttpStatus,
  BadRequestException,
  Body,
  Post,
  Res,
} from '@nestjs/common';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { toDataURL } from 'qrcode';
import { loadPassword, settings } from './config';
import { MAX_TRUST_DAYS, TRUST_COOKIE, TwoFactorService } from './two-factor';

export const COOKIE = 'adb_session';
export interface LoginSession {
  id: string;
  expiresAt: number;
}
export type AuthRequest = FastifyRequest & { session: LoginSession };

@Injectable()
export class AuthService {
  private readonly salt = randomBytes(32);
  private readonly passwordHash: Buffer;
  private readonly sessionKey: Buffer;
  private readonly sessionFile = settings.sessionFile;
  private readonly sessions = new Map<string, LoginSession>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly challenges = new Map<
    string,
    { ip: string; expiresAt: number; version: string; attempts: number }
  >();

  constructor(private readonly factor: TwoFactorService = new TwoFactorService()) {
    const password = loadPassword();
    this.passwordHash = scryptSync(password, this.salt, 32);
    this.sessionKey = scryptSync(password, 'adb-session-store-v1', 32);
    if (!existsSync(this.sessionFile)) return;
    const entries: unknown = JSON.parse(readFileSync(this.sessionFile, 'utf8'));
    if (!Array.isArray(entries)) throw new Error('Invalid session store');
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid session entry');
      const [key, session] = entry;
      if (
        typeof key !== 'string' ||
        !/^[a-f0-9]{64}$/.test(key) ||
        !session ||
        typeof session.id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(session.id) ||
        !Number.isSafeInteger(session.expiresAt)
      ) {
        throw new Error('Invalid session entry');
      }
      if (session.expiresAt > Date.now())
        this.sessions.set(key, { id: session.id, expiresAt: session.expiresAt });
    }
    if (this.sessions.size > 1) {
      const latest = [...this.sessions.entries()].at(-1)!;
      this.sessions.clear();
      this.sessions.set(...latest);
      this.persist();
    }
  }

  login(password: string, ip: string) {
    this.checkPassword(password, ip);
    if (this.factor.enabled) throw new UnauthorizedException('需要双重验证');
    this.failures.delete(ip);
    return this.createSession();
  }

  beginLogin(password: string, ip: string, trustedToken?: string) {
    this.checkPassword(password, ip);
    if (!this.factor.enabled || this.factor.isTrusted(trustedToken)) {
      this.failures.delete(ip);
      return this.createSession();
    }
    for (const [key, challenge] of this.challenges)
      if (challenge.expiresAt <= Date.now()) this.challenges.delete(key);
    if (this.challenges.size >= 1000) throw new HttpException('请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    const challenge = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 5 * 60_000;
    this.challenges.set(this.hash(challenge), { ip, expiresAt, version: this.factor.version, attempts: 0 });
    return { requiresTwoFactor: true as const, challenge, expiresAt, maxTrustDays: MAX_TRUST_DAYS };
  }

  completeLogin(challengeToken: string, code: string, days: number, ip: string) {
    this.checkAttempt(ip);
    const key = this.hash(challengeToken);
    const challenge = this.challenges.get(key);
    if (
      !challenge ||
      challenge.ip !== ip ||
      challenge.expiresAt <= Date.now() ||
      challenge.version !== this.factor.version ||
      challenge.attempts >= 5
    ) {
      this.challenges.delete(key);
      this.failAttempt(ip);
      throw new UnauthorizedException('验证已失效，请重新输入密码');
    }
    challenge.attempts += 1;
    if (!this.factor.verify(code)) {
      this.failAttempt(ip);
      if (challenge.attempts >= 5) this.challenges.delete(key);
      throw new UnauthorizedException('验证码无效、已使用或已过期');
    }
    this.challenges.delete(key);
    this.failures.delete(ip);
    const trusted = days > 0 ? this.factor.remember(days) : undefined;
    return { ...this.createSession(), trusted };
  }

  checkSecurity(password: string, code: string, ip: string) {
    try {
      this.checkPassword(password, ip);
    } catch (error) {
      if (error instanceof UnauthorizedException) throw new BadRequestException('密码或验证码不正确');
      throw error;
    }
    if (this.factor.enabled && !this.factor.verify(code)) {
      this.failAttempt(ip);
      throw new BadRequestException('密码或验证码不正确、已使用或已过期');
    }
    this.failures.delete(ip);
  }

  enableFactor(sessionId: string, code: string, ip: string) {
    this.checkAttempt(ip);
    try {
      const result = this.factor.enable(sessionId, code);
      this.failures.delete(ip);
      this.challenges.clear();
      return result;
    } catch (error) {
      this.failAttempt(ip);
      throw error;
    }
  }

  private checkAttempt(ip: string) {
    const now = Date.now();
    for (const [key, attempt] of this.failures) if (attempt.until <= now) this.failures.delete(key);
    const attempt = this.failures.get(ip) || { count: 0, until: now + settings.loginWindowMinutes * 60_000 };
    if (attempt.count >= settings.loginMaxAttempts) {
      throw new HttpException(
        { message: '尝试次数过多，请稍后重试', retryAfter: Math.ceil((attempt.until - now) / 1000) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return attempt;
  }
  private failAttempt(ip: string) {
    const attempt = this.checkAttempt(ip);
    attempt.count += 1;
    this.failures.set(ip, attempt);
  }
  private checkPassword(password: string, ip: string) {
    this.checkAttempt(ip);
    if (!timingSafeEqual(scryptSync(password, this.salt, 32), this.passwordHash)) {
      this.failAttempt(ip);
      throw new UnauthorizedException('访问密码不正确');
    }
  }
  private createSession() {
    const token = randomBytes(32).toString('base64url');
    const session = {
      id: randomBytes(16).toString('hex'),
      expiresAt: Date.now() + settings.sessionHours * 3_600_000,
    };
    this.sessions.clear();
    this.sessions.set(this.hash(token), session);
    this.persist();
    return { token, session };
  }

  isActive(sessionId: string) {
    return [...this.sessions.values()].some(
      (session) => session.id === sessionId && session.expiresAt > Date.now(),
    );
  }

  find(token?: string): LoginSession | undefined {
    if (!token) return;
    const key = this.hash(token);
    const session = this.sessions.get(key);
    if (session && session.expiresAt > Date.now()) return session;
    if (this.sessions.delete(key)) this.persist();
  }

  revoke(token?: string) {
    if (token && this.sessions.delete(this.hash(token))) this.persist();
  }
  private hash(token: string) {
    return createHmac('sha256', this.sessionKey).update(token).digest('hex');
  }
  private persist() {
    mkdirSync(path.dirname(this.sessionFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.sessionFile}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.sessions]), { mode: 0o600 });
    renameSync(temporary, this.sessionFile);
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const session = this.auth.find(request.cookies[COOKIE]);
    if (!session) throw new UnauthorizedException('登录已过期，请重新登录');
    request.session = session;
    return true;
  }
}

export class LoginDto {
  @IsString() @MinLength(1) password!: string;
}

export class VerifyLoginDto {
  @IsString() @MinLength(43) @MaxLength(43) challenge!: string;
  @IsString() @MinLength(6) @MaxLength(20) code!: string;
  @IsInt() @Min(0) @Max(MAX_TRUST_DAYS) rememberDays = 0;
}
class SecurityDto extends LoginDto {
  @IsOptional() @IsString() @MaxLength(20) code?: string;
}
class EnableFactorDto {
  @IsString() @MinLength(6) @MaxLength(6) code!: string;
}

@Controller('auth')
class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly factor: TwoFactorService,
  ) {}

  @Get('config')
  config() {
    return { mode: 'password', sessionHours: settings.sessionHours };
  }

  @Get('session')
  @UseGuards(AuthGuard)
  session(@Req() request: AuthRequest) {
    return { expiresAt: request.session.expiresAt };
  }

  @Get('two-factor')
  @UseGuards(AuthGuard)
  security(@Req() request: AuthRequest) {
    return this.factor.status(request.cookies[TRUST_COOKIE]);
  }

  @Post('two-factor/setup')
  @UseGuards(AuthGuard)
  async setup(@Body() body: LoginDto, @Req() request: AuthRequest) {
    this.auth.checkSecurity(body.password, '', request.ip);
    const setup = this.factor.begin(request.session.id);
    return { ...setup, qrCode: await toDataURL(setup.uri, { width: 240, margin: 2 }) };
  }

  @Post('two-factor/enable')
  @UseGuards(AuthGuard)
  enable(@Body() body: EnableFactorDto, @Req() request: AuthRequest) {
    return this.auth.enableFactor(request.session.id, body.code, request.ip);
  }

  @Post('two-factor/disable')
  @UseGuards(AuthGuard)
  disable(
    @Body() body: SecurityDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.auth.checkSecurity(body.password, body.code || '', request.ip);
    this.factor.disable();
    reply.clearCookie(TRUST_COOKIE, { path: '/api/auth' });
    return { ok: true };
  }

  @Post('two-factor/revoke-trusted')
  @UseGuards(AuthGuard)
  revokeTrusted(
    @Body() body: SecurityDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.auth.checkSecurity(body.password, body.code || '', request.ip);
    this.factor.revokeTrusted();
    reply.clearCookie(TRUST_COOKIE, { path: '/api/auth' });
    return { ok: true };
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, TwoFactorService],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
