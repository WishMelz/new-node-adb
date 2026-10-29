import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { IncomingMessage } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { AuthModule, AuthService, COOKIE, LoginDto, VerifyLoginDto } from './auth';
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
    const result = this.auth.beginLogin(body.password, request.ip, request.cookies[TRUST_COOKIE]);
    if ('requiresTwoFactor' in result) return result;
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
    this.auth.revoke(token);
    await this.streams.stopForAuth(request.session.id);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  }
}

@Module({ imports: [AuthModule, DevicesModule, StreamModule], controllers: [AppController] })
class AppModule {}

export function originAllowed(origin: string | undefined, host: string | undefined) {
  if (!origin) return true;
  if (settings.origin) return origin === settings.origin;
  return origin === `${settings.secureCookie ? 'https' : 'http'}://${host}`;
}

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
    new FastifyAdapter({ logger: false }),
  );
  const server = app.getHttpAdapter().getInstance();
  await server.register(cookie);
  await server.register(helmet, { contentSecurityPolicy: false });
  await server.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  server.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/auth/')) reply.header('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !originAllowed(request.headers.origin, request.headers.host)
    ) {
      return reply.code(403).send({ message: '请求来源不被允许' });
    }
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  if (existsSync(path.join(webRoot, 'index.html'))) {
    await server.register(fastifyStatic, { root: webRoot, wildcard: false });
  }
  const httpServer = app.getHttpServer();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  httpServer.on('upgrade', (request: IncomingMessage, socket, head: Buffer) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      const match = url.pathname.match(/^\/ws\/streams\/([^/]+)$/);
      if (!request.headers.origin || !originAllowed(request.headers.origin, request.headers.host))
        return socket.destroy();
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
      await app.listen({ host: settings.host, port: settings.port });
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
