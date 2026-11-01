import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const image = process.argv.slice(2).find((argument) => !argument.startsWith('--')) || 'adb-desk:local'
const prefix = `adb-desk-smoke-${process.pid}-${Date.now()}`
const volume = `${prefix}-data`
const temporary = mkdtempSync(path.join(tmpdir(), 'adb-desk-smoke-'))
const containers = new Set()
let volumeCreated = false

function docker(args) {
  try {
    return execFileSync('docker', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const diagnostic = error.stderr?.toString().match(/SMOKE_PHASE=[a-z-]+;ERROR=[A-Za-z]+/)
    throw new Error(
      `Docker ${args[0]} failed (status ${error.status ?? error.code})${diagnostic ? ': ' + diagnostic[0] : ''}`,
    )
  }
}

async function ready(container) {
  await new Promise((resolve, reject) => {
    const logs = spawn('docker', ['logs', '--follow', container], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let finished = false
    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      logs.kill()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('Container readiness timed out')), 30_000)
    logs.on('error', finish)
    logs.on('exit', () => finish(new Error('Container exited before readiness')))
    for (const stream of [logs.stdout, logs.stderr]) {
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-8192)
        if (output.includes('Nest application successfully started')) finish()
      })
    }
  })
}

const probe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {createHash, createPublicKey, publicDecrypt, constants, randomBytes} = require('node:crypto');
const net = require('node:net');
const {settings} = require('./apps/api/dist/config');
let phase = 'baseline';
(async () => {
  const [mode, expectedPort, expectedDirectory] = process.argv.slice(1);
  assert.equal(settings.port, Number(expectedPort));
  assert.equal(settings.dataDir, expectedDirectory);
  assert.ok(process.getuid() !== 0);
  assert.ok(!fs.existsSync('/usr/sbin/nginx'));
  assert.ok(!fs.existsSync('/app/.env'));
  assert.ok(!fs.existsSync('/app/node_modules/vite'));
  assert.match(execFileSync('/usr/bin/adb', ['version'], {encoding:'utf8'}), /Android Debug Bridge/);
  assert.ok(fs.statSync(settings.scrcpyPath).size > 0);
  const bitmap = await require('sharp')({create:{width:2,height:2,channels:3,background:'#00aabb'}}).webp().toBuffer();
  assert.equal((await require('sharp')(bitmap).metadata()).format, 'webp');
  const base = 'http://127.0.0.1:' + settings.port;
  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const {AdbService} = require('./apps/api/dist/adb');
  phase = 'identity-start';
  const adb = new AdbService();
  const token = randomBytes(20);
  const clients = new Set();
  let authenticated = false;
  const packet = (command, argument, payload) => {
    const header = Buffer.alloc(24);
    const value = Buffer.from(command).readUInt32LE();
    header.writeUInt32LE(value, 0);
    header.writeUInt32LE(argument, 4);
    header.writeUInt32LE(payload.length, 12);
    header.writeUInt32LE(payload.reduce((sum, byte) => sum + byte, 0), 16);
    header.writeUInt32LE((value ^ 0xffffffff) >>> 0, 20);
    return Buffer.concat([header, payload]);
  };
  const device = net.createServer(connection => {
    clients.add(connection);
    connection.on('close', () => clients.delete(connection));
    connection.on('error', () => {});
    let pending = Buffer.alloc(0);
    connection.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 24) {
        const length = pending.readUInt32LE(12);
        if (pending.length < 24 + length) return;
        const command = pending.subarray(0, 4).toString();
        const argument = pending.readUInt32LE(4);
        const payload = pending.subarray(24, 24 + length);
        pending = pending.subarray(24 + length);
        if (command === 'CNXN') connection.write(packet('AUTH', 1, token));
        if (command === 'AUTH') {
          try {
            assert.equal(argument, 2);
            const key = createPublicKey(fs.readFileSync(path.join(settings.dataDir, '.android', 'adbkey')));
            const digest = publicDecrypt({key, padding:constants.RSA_PKCS1_PADDING}, payload);
            assert.deepEqual(digest, Buffer.concat([Buffer.from('3021300906052b0e03021a05000414', 'hex'), token]));
            authenticated = true;
          } catch {}
          connection.destroy();
        }
      }
    });
  });
  await new Promise(resolve => device.listen(0, '127.0.0.1', resolve));
  const identityFile = path.join(settings.dataDir, 'smoke-identity');
  try {
    assert.deepEqual(await adb.devices(), []);
    phase = 'identity-files';
    const privateFile = path.join(settings.dataDir, '.android', 'adbkey');
    const fingerprint = createHash('sha256').update(fs.readFileSync(privateFile)).digest('hex');
    assert.equal(fs.statSync(privateFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(privateFile)).mode & 0o777, 0o700);
    if (mode === 'create') fs.writeFileSync(identityFile, fingerprint, {mode:0o600});
    else assert.equal(fs.readFileSync(identityFile, 'utf8'), fingerprint);
    phase = 'identity-signature';
    await adb.text(['connect', '127.0.0.1:' + device.address().port]);
    assert.equal(authenticated, true, 'ADB must sign with the persisted identity');
    assert.match(adb.socket, /^tcp:\d+$/);
    assert.notEqual(adb.socket, 'tcp:5037');
  } finally {
    await adb.beforeApplicationShutdown();
    for (const client of clients) client.destroy();
    await new Promise(resolve => device.close(resolve));
  }
  const restarted = new AdbService();
  phase = 'identity-restart';
  try {
    assert.deepEqual(await restarted.devices(), []);
    phase = 'server-crash-recovery';
    const previousServer = restarted.server;
    const exited = once(previousServer, 'exit');
    previousServer.kill('SIGKILL');
    await exited;
    const results = await Promise.all([restarted.devices(), restarted.devices()]);
    assert.deepEqual(results, [[], []]);
    assert.notEqual(restarted.server.pid, previousServer.pid);
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(settings.dataDir, '.android', 'adbkey'))).digest('hex'), fs.readFileSync(identityFile, 'utf8'));
  } finally {
    await restarted.beforeApplicationShutdown();
  }
  await assert.rejects(restarted.devices(), /关闭/);
  assert.throws(() => restarted.spawn('test-device', ['shell', 'true']), /未就绪/);
  if (mode === 'restore') fs.unlinkSync(identityFile);
  phase = 'http';
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  const html = await home.text();
  assert.ok(!html.includes('/@vite/client'));
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(assets.length >= 2);
  for (const asset of assets) assert.equal((await fetch(base + asset)).status, 200);
  for (const missing of ['/.env', '/api/unknown', '/assets/missing.js']) {
    assert.equal((await fetch(base + missing)).status, 404);
  }
  assert.equal((await fetch(base + '/api/devices')).status, 401);
  const password = fs.readFileSync(path.join(settings.dataDir, 'bootstrap-password'), 'utf8').trim();
  assert.ok(password);
  assert.equal(fs.statSync(path.join(settings.dataDir, 'bootstrap-password')).mode & 0o777, 0o600);
  const cookieFile = path.join(settings.dataDir, 'smoke-session');
  if (mode === 'create') {
    const login = await fetch(base + '/api/auth/login', {
      method:'POST', headers:{'content-type':'application/json',origin:'https://independent.example'},
      body:JSON.stringify({password})
    });
    assert.equal(login.status, 201);
    const header = login.headers.get('set-cookie');
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Strict/i);
    fs.writeFileSync(cookieFile, header.split(';')[0], {mode:0o600});
    assert.ok(fs.existsSync(path.join(settings.dataDir, 'sessions.json')));
    phase = 'http-adb-lifecycle';
    assert.equal((await fetch(base + '/api/devices', {headers:{cookie:header.split(';')[0]}})).status, 200);
  } else {
    const cookie = fs.readFileSync(cookieFile, 'utf8');
    assert.equal((await fetch(base + '/api/auth/session', {headers:{cookie}})).status, 200);
    phase = 'http-adb-lifecycle';
    assert.equal((await fetch(base + '/api/devices', {headers:{cookie}})).status, 200);
    assert.equal((await fetch(base + '/api/auth/logout', {method:'POST',headers:{cookie}})).status, 201);
    assert.equal((await fetch(base + '/api/auth/session', {headers:{cookie}})).status, 401);
    fs.unlinkSync(cookieFile);
  }
  console.log('PASS: ' + mode + ', port=' + settings.port + ', data=' + settings.dataDir + ', assets/auth/ADB identity+signature+restart/sharp');
})().catch(error => {console.error('SMOKE_PHASE=' + phase + ';ERROR=' + error.name);process.exitCode=1;});
`

function stop(container) {
  docker(['stop', '--time', '15', container])
  const state = JSON.parse(docker(['inspect', container]))[0].State
  assert.ok([0, 143].includes(state.ExitCode), `Unexpected shutdown code ${state.ExitCode}`)
  assert.equal(state.OOMKilled, false)
  docker(['rm', container])
  containers.delete(container)
}

try {
  const service = JSON.parse(docker(['compose', 'config', '--format', 'json'])).services['adb-desk']
  assert.equal(service.network_mode, 'host')
  assert.equal(service.ports, undefined)
  assert.equal(service.environment.DATA_DIR, '/app/.data')
  assert.equal(service.volumes[0].target, '/app/.data')
  const metadata = JSON.parse(docker(['image', 'inspect', image]))[0]
  assert.equal(metadata.Config.User, 'node')
  assert.deepEqual(metadata.Config.Cmd, ['node', 'apps/api/dist/main.js'])
  docker(['volume', 'create', volume])
  volumeCreated = true

  for (const [mode, port, directory, storage] of [
    ['create', 23120, '/app/.data', 'volume'],
    ['restore', 24120, '/custom-data', 'volume'],
    ...(process.platform === 'win32'
      ? [
          ['create', 23120, '/app/.data', 'bind'],
          ['restore', 24120, '/custom-data', 'bind'],
        ]
      : []),
  ]) {
    const container = `${prefix}-${storage}-${mode}`
    containers.add(container)
    docker([
      'run',
      '-d',
      '--name',
      container,
      '--network',
      'none',
      '--init',
      '--memory',
      '256m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--mount',
      `type=${storage},source=${storage === 'bind' ? temporary : volume},target=${directory}`,
      '-e',
      'NODE_OPTIONS=--max-old-space-size=128',
      '-e',
      'ADMIN_PASSWORD=',
      '-e',
      'DEV_API_PORT=invalid',
      '-e',
      'DEV_WEB_PORT=invalid',
      ...(mode === 'restore' ? ['-e', `DOCKER_PORT=${port}`, '-e', `DATA_DIR=${directory}`] : []),
      image,
    ])
    await ready(container)
    console.log(docker(['exec', container, 'node', '-e', probe, mode, String(port), directory]).trim())
    docker(['exec', container, ...service.healthcheck.test.slice(1)])
    const processes = docker(['top', container, '-eo', 'pid,comm'])
    assert.equal(processes.split('\n').filter((line) => /\bnode\b/.test(line)).length, 1)
    assert.equal(processes.split('\n').filter((line) => /\badb\b/.test(line)).length, 1)
    stop(container)
  }
  console.log(
    'PASS: fresh volume ownership, recreated-container session persistence, dynamic health and shutdown',
  )

  if (process.argv.includes('--host')) {
    const reservation = net.createServer()
    await new Promise((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', resolve)
    })
    const port = reservation.address().port
    await new Promise((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())))
    const composeFile = path.join(temporary, 'compose.json')
    const container = `${prefix}-host`
    writeFileSync(
      composeFile,
      JSON.stringify({
        services: {
          check: {
            image,
            container_name: container,
            network_mode: service.network_mode,
            init: true,
            environment: {
              NODE_ENV: 'production',
              DOCKER_PORT: String(port),
              ADMIN_PASSWORD: '',
              DATA_DIR: '/app/.data',
              NODE_OPTIONS: service.environment.NODE_OPTIONS,
            },
            tmpfs: ['/app/.data:uid=1000,gid=1000,mode=700'],
            cap_drop: service.cap_drop,
            security_opt: service.security_opt,
            mem_limit: service.mem_limit,
            healthcheck: { ...service.healthcheck, interval: '1s', start_period: '1s', retries: 20 },
          },
        },
      }),
    )
    containers.add(container)
    docker(['compose', '-p', prefix, '-f', composeFile, 'up', '-d', '--wait', '--wait-timeout', '45'])
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).ok, true)
      console.log('PASS: Compose host network reachable from the host without port mappings')
    } catch {
      throw new Error(
        'Container is healthy but host networking is not reachable; check Docker Desktop host networking support/settings',
      )
    }
    stop(container)
  }
} finally {
  const cleanup = [
    ...[...containers].map((container) => () => docker(['rm', '-f', container])),
    ...(volumeCreated ? [() => docker(['volume', 'rm', volume])] : []),
    () => rmSync(temporary, { recursive: true, force: true }),
  ]
  for (const action of cleanup) {
    try {
      action()
    } catch {
      console.error(`Cleanup failed for test resources (${prefix})`)
      process.exitCode = 1
    }
  }
}
