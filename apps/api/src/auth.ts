import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  Req,
  UnauthorizedException,
  ConflictException,
  UseGuards,
  HttpException,
  HttpStatus,
  BadRequestException,
  Body,
  Post,
  Res,
} from '@nestjs/common';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { toDataURL } from 'qrcode';
import { loadPassword, settings } from './config';
import { MAX_TRUST_DAYS, TRUST_COOKIE, TwoFactorService } from './two-factor';
import { StorageModule, StorageService } from './storage';

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
  private readonly configuredPassword = loadPassword();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly challenges = new Map<
    string,
    { ip: string; expiresAt: number; version: string; attempts: number }
  >();

  constructor(
    private readonly factor: TwoFactorService = new TwoFactorService(),
    private readonly store: StorageService = factor.store,
  ) {
    this.passwordHash = this.configuredPassword
      ? scryptSync(this.configuredPassword, this.salt, 32)
      : Buffer.alloc(0);
  }

  mode(): 'password' | 'register' {
    return this.configuredPassword || this.store.adminAccount() ? 'password' : 'register';
  }

  register(password: string, confirmation: string, ip: string) {
    if (this.mode() === 'password') throw new ConflictException('管理员已注册，请直接登录');
    if (password !== confirmation) throw new BadRequestException('两次输入的密码不一致');
    this.checkAttempt(ip);
    const salt = randomBytes(32);
    const passwordHash = scryptSync(password, salt, 32);
    const token = randomBytes(32).toString('base64url');
    const session = {
      id: randomBytes(16).toString('hex'),
      expiresAt: Date.now() + settings.sessionHours * 3_600_000,
    };
    this.store.transaction((database) => {
      const inserted = database
        .prepare(
          'INSERT OR IGNORE INTO admin_account (singleton, passwordSalt, passwordHash, createdAt) VALUES (1, ?, ?, ?)',
        )
        .run(salt.toString('base64'), passwordHash.toString('base64'), Date.now());
      if (Number(inserted.changes) !== 1) throw new ConflictException('管理员已注册，请直接登录');
      database.exec('DELETE FROM sessions');
      database
        .prepare('INSERT INTO sessions (tokenHash, id, expiresAt) VALUES (?, ?, ?)')
        .run(this.hash(token), session.id, session.expiresAt);
    });
    this.failures.delete(ip);
    return { token, session };
  }

  login(password: string, ip: string) {
    this.checkPassword(password, ip);
    if (this.factor.enabled) throw new UnauthorizedException('需要双重验证');
    this.failures.delete(ip);
    return this.createSession();
  }

  beginLogin(password: string, ip: string, trustedToken?: string) {
    if (this.mode() === 'register') throw new ConflictException('请先注册管理员');
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
    const result = this.store.transaction(() => {
      if (!this.factor.verify(code)) {
        this.failAttempt(ip);
        if (challenge.attempts >= 5) this.challenges.delete(key);
        throw new UnauthorizedException('验证码无效、已使用或已过期');
      }
      const trusted = days > 0 ? this.factor.remember(days) : undefined;
      return { ...this.createSession(), trusted };
    });
    this.challenges.delete(key);
    this.failures.delete(ip);
    return result;
  }

  changeFactor(password: string, code: string, ip: string, action: 'disable' | 'revoke-trusted') {
    this.store.transaction(() => {
      this.checkSecurity(password, code, ip);
      if (action === 'disable') this.factor.disable();
      else this.factor.revokeTrusted();
    });
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
    const account = this.store.adminAccount();
    if (!this.configuredPassword && !account) throw new ConflictException('请先注册管理员');
    const expected = this.configuredPassword
      ? this.passwordHash
      : account
        ? Buffer.from(account.passwordHash, 'base64')
        : Buffer.alloc(0);
    const actual = this.configuredPassword
      ? scryptSync(password, this.salt, 32)
      : account
        ? scryptSync(password, Buffer.from(account.passwordSalt, 'base64'), 32)
        : Buffer.alloc(0);
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
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
    this.store.transaction((database) => {
      database.exec('DELETE FROM sessions');
      database
        .prepare('INSERT INTO sessions (tokenHash, id, expiresAt) VALUES (?, ?, ?)')
        .run(this.hash(token), session.id, session.expiresAt);
    });
    return { token, session };
  }

  isActive(sessionId: string) {
    return this.store.read(
      (database) =>
        !!database
          .prepare('SELECT id FROM sessions WHERE id = ? AND expiresAt > ?')
          .get(sessionId, Date.now()),
    );
  }

  find(token?: string): LoginSession | undefined {
    if (!token || this.mode() === 'register') return;
    return this.store.read((database) => {
      const session = database
        .prepare('SELECT id, expiresAt FROM sessions WHERE tokenHash = ? AND expiresAt > ?')
        .get(this.hash(token), Date.now());
      return session ? { id: String(session.id), expiresAt: Number(session.expiresAt) } : undefined;
    });
  }

  revoke(token?: string) {
    if (token)
      this.store.transaction((database) => {
        database.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(this.hash(token));
      });
  }
  private hash(token: string) {
    return createHmac('sha256', this.sessionKey()).update(token).digest('hex');
  }
  private sessionKey() {
    if (this.configuredPassword) return scryptSync(this.configuredPassword, 'adb-session-store-v1', 32);
    const account = this.store.adminAccount();
    if (!account) throw new ConflictException('请先注册管理员');
    return scryptSync(account.passwordHash, 'adb-session-store-v1', 32);
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

export class RegisterDto extends LoginDto {
  @IsString() @MinLength(1) confirmPassword!: string;
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
    return { mode: this.auth.mode(), sessionHours: settings.sessionHours };
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
    this.auth.changeFactor(body.password, body.code || '', request.ip, 'disable');
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
    this.auth.changeFactor(body.password, body.code || '', request.ip, 'revoke-trusted');
    reply.clearCookie(TRUST_COOKIE, { path: '/api/auth' });
    return { ok: true };
  }
}

@Module({
  imports: [StorageModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, TwoFactorService],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
