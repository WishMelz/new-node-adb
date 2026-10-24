import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  Post,
  Body,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IsString, MaxLength, MinLength } from 'class-validator';
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadPassword, settings } from './config';

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

  constructor() {
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
  }

  login(password: string, ip: string) {
    const now = Date.now();
    for (const [key, attempt] of this.failures) if (attempt.until <= now) this.failures.delete(key);
    const attempt = this.failures.get(ip) || { count: 0, until: now + settings.loginWindowMinutes * 60_000 };
    if (attempt.count >= settings.loginMaxAttempts) {
      throw new HttpException(
        { message: '尝试次数过多，请稍后重试', retryAfter: Math.ceil((attempt.until - now) / 1000) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!timingSafeEqual(scryptSync(password, this.salt, 32), this.passwordHash)) {
      attempt.count += 1;
      this.failures.set(ip, attempt);
      throw new UnauthorizedException('访问密码不正确');
    }
    this.failures.delete(ip);
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    const session = {
      id: randomBytes(16).toString('hex'),
      expiresAt: now + settings.sessionHours * 3_600_000,
    };
    this.sessions.set(this.hash(token), session);
    this.persist();
    return { token, session };
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

class LoginDto {
  @IsString() @MinLength(1) @MaxLength(256) password!: string;
}

@Controller('auth')
class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('config')
  config() {
    return { mode: 'password', sessionHours: settings.sessionHours };
  }

  @Post('login')
  login(
    @Body() body: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { token, session } = this.auth.login(body.password, request.ip);
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: settings.secureCookie,
      path: '/',
      maxAge: settings.sessionHours * 3600,
    });
    return { expiresAt: session.expiresAt };
  }

  @Get('session')
  @UseGuards(AuthGuard)
  session(@Req() request: AuthRequest) {
    return { expiresAt: request.session.expiresAt };
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
