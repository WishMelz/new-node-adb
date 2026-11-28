import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { IncomingMessage } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { constants as zlibConstants, createBrotliCompress, createGzip } from 'node:zlib';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import {
  AuthModule,
  AuthService,
  COOKIE,
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  VerifyLoginDto,
} from './auth';
import { TRUST_COOKIE } from './two-factor';
import { DevicesModule } from './devices';
import { root, settings } from './config';
import { StreamModule, StreamService } from './stream';
import {
  Body,
  Controller,
  Get,
  Module,
  Req,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard, AuthRequest } from './auth';

@Controller()
class AppController {
  constructor(
    private readonly auth: AuthService,
    private readonly streams: StreamService,
  ) {}
  @Get('health') health() {
    return { ok: true, uptime: process.uptime() };
  }
  @Post('auth/login')
  async login(
    @Body() body: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.beginLoginAsync(body.password, request.ip, request.cookies[TRUST_COOKIE]);
    if ('requiresTwoFactor' in result) return result;
    return this.finishLogin(result, reply);
  }
  @Post('auth/register')
  async register(
    @Body() body: RegisterDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.registerAsync(body.password, body.confirmPassword, request.ip);
    return this.finishLogin(result, reply);
  }
  @Post('auth/verify')
  async verify(
    @Body() body: VerifyLoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = this.auth.completeLogin(body.challenge, body.code, body.rememberDays, request.ip);
    const response = await this.finishLogin(result, reply);
    if (result.trusted)
      reply.setCookie(TRUST_COOKIE, result.trusted.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: settings.secureCookie,
        path: '/api/auth',
        maxAge: Math.max(0, Math.floor((result.trusted.expiresAt - Date.now()) / 1000)),
      });
    else reply.clearCookie(TRUST_COOKIE, { path: '/api/auth' });
    return response;
  }
  private async finishLogin({ token, session }: ReturnType<AuthService['login']>, reply: FastifyReply) {
    await this.streams.stopInactive();
    if (!this.auth.isActive(session.id)) throw new UnauthorizedException('登录已被其他登录替换');
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: settings.secureCookie,
      path: '/',
      maxAge: settings.sessionHours * 3600,
    });
    return { expiresAt: session.expiresAt };
  }
  @Post('auth/logout')
  @UseGuards(AuthGuard)
  async logout(@Req() request: AuthRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = request.cookies[COOKIE];
    try {
      this.auth.revoke(token);
    } finally {
      await this.streams.stopForAuth(request.session.id);
    }
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  }
  @Post('auth/password')
  @UseGuards(AuthGuard)
  async changePassword(
    @Body() body: ChangePasswordDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.changePasswordAsync(
      body.currentPassword,
      body.newPassword,
      body.confirmPassword,
      body.code || '',
      request.ip,
    );
    await this.streams.stopForAuth(request.session.id);
    reply.clearCookie(COOKIE, { path: '/' });
    reply.clearCookie(TRUST_COOKIE, { path: '/api/auth' });
    return { ok: true };
  }
}

@Module({ imports: [AuthModule, DevicesModule, StreamModule], controllers: [AppController] })
class AppModule {}

function scheduleSessionExpiry(callback: () => void, expiresAt: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    timer.unref();
  };
  schedule();
  return () => clearTimeout(timer);
}

export async function createApp(webRoot = path.join(root, 'apps/web/dist')) {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: settings.trustProxy }),
  );
  const server = app.getHttpAdapter().getInstance();
  await server.register(cookie);
  await server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  });
  await server.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  server.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/auth/')) reply.header('Cache-Control', 'no-store');
  });
  const compressibleType = /^(?:text\/|application\/(?:javascript|json)|image\/svg\+xml)/i;
  server.addHook('onSend', async (request, reply, payload) => {
    if (
      request.method === 'HEAD' ||
      reply.statusCode < 200 ||
      reply.statusCode === 204 ||
      reply.statusCode === 304 ||
      reply.getHeader('content-encoding')
    )
      return payload;
    const contentType = String(reply.getHeader('content-type') || '');
    if (!compressibleType.test(contentType)) return payload;
    const accept = String(request.headers['accept-encoding'] || '');
    const encoding = /\bbr\b/i.test(accept) ? 'br' : /\bgzip\b/i.test(accept) ? 'gzip' : '';
    if (!encoding) return payload;
    const source =
      typeof payload === 'string'
        ? Buffer.from(payload)
        : Buffer.isBuffer(payload)
          ? payload
          : payload instanceof Readable
            ? payload
            : null;
    if (!source) return payload;
    if (Buffer.isBuffer(source) && source.length < 1024) return payload;
    const existingLength = Number(reply.getHeader('content-length') || 0);
    if (!Buffer.isBuffer(source) && existingLength > 0 && existingLength < 1024) return payload;
    const vary = String(reply.getHeader('vary') || '');
    if (!/\baccept-encoding\b/i.test(vary)) {
      reply.header('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
    }
    reply.header('content-encoding', encoding);
    reply.removeHeader('content-length');
    const compressor =
      encoding === 'br'
        ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
        : createGzip({ level: 6 });
    return Buffer.isBuffer(source) ? Readable.from(source).pipe(compressor) : source.pipe(compressor);
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  if (existsSync(path.join(webRoot, 'index.html'))) {
    const assetsRoot = path.join(webRoot, 'assets');
    await server.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      setHeaders: (reply, filePath) => {
        if (filePath.startsWith(assetsRoot + path.sep)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (path.basename(filePath) === 'index.html') {
          reply.header('Cache-Control', 'no-cache');
        }
      },
    });
  }
  const httpServer = app.getHttpServer();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  httpServer.on('upgrade', (request: IncomingMessage, socket, head: Buffer) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      const match = url.pathname.match(/^\/ws\/streams\/([^/]+)$/);
      const token = server.parseCookie(request.headers.cookie || '')[COOKIE];
      const session = app.get(AuthService).find(token);
      const stream = match ? app.get(StreamService).get(match[1]) : undefined;
      if (!match || !session || !stream || stream.authSessionId !== session.id) return socket.destroy();
      wsServer.handleUpgrade(request, socket, head, (client) => {
        const cancelExpiry = scheduleSessionExpiry(() => {
          void app.get(StreamService).stopForAuth(session.id);
          client.close(1008, 'session expired');
        }, session.expiresAt);
        client.once('close', cancelExpiry);
        stream.attach(client);
      });
    } catch {
      socket.destroy();
    }
  });
  server.addHook('onClose', async () => {
    for (const client of wsServer.clients) client.terminate();
    wsServer.close();
  });
  await app.init();
  return app;
}

if (require.main === module) {
  void createApp()
    .then(async (app) => {
      app.enableShutdownHooks();
      await app.listen({ host: '0.0.0.0', port: settings.port });
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
