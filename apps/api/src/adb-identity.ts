import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export function adbEnvironment(dataDir: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of ['ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_PORT', 'ANDROID_SERIAL', 'ADB_TRACE'])
    delete environment[name];
  return {
    ...environment,
    HOME: dataDir,
    USERPROFILE: dataDir,
    ANDROID_SDK_HOME: dataDir,
    ANDROID_USER_HOME: path.join(dataDir, '.android'),
    ADB_VENDOR_KEYS: path.join(dataDir, '.android', 'adbkey'),
    ADB_MDNS_AUTO_CONNECT: '0',
    ADB_LOCAL_TRANSPORT_MAX_PORT: '0',
  };
}

function privateKey(filename: string) {
  if (!lstatSync(filename).isFile()) throw new Error('ADB key must be a regular file');
  let key;
  try {
    key = createPrivateKey(readFileSync(filename));
  } catch {
    throw new Error('Invalid ADB private key; existing keys were not replaced');
  }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048)
    throw new Error('ADB requires a 2048-bit RSA private key');
  return {
    pem: key.export({ type: 'pkcs1', format: 'pem' }),
    fingerprint: createHash('sha256')
      .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
      .digest('hex'),
  };
}

async function publicKey(adbPath: string, filename: string, environment: NodeJS.ProcessEnv) {
  try {
    const result = await promisify(execFile)(adbPath, ['pubkey', filename], {
      env: environment,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const value = result.stdout.trim();
    if (Buffer.from(value.split(/\s+/)[0] || '', 'base64').length !== 524) throw new Error();
    return value;
  } catch {
    throw new Error('Unable to derive ADB public key; check ADB_PATH and Platform Tools version');
  }
}

function checkPublicKey(filename: string, expected: string) {
  if (!existsSync(filename)) return;
  if (
    !lstatSync(filename).isFile() ||
    readFileSync(filename, 'utf8').trim().split(/\s+/)[0] !== expected.split(/\s+/)[0]
  )
    throw new Error('ADB public/private key mismatch; existing keys were not replaced');
}

function checkDirectory(directory: string) {
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
    throw new Error('ADB identity directory must not be a symbolic link');
}

export async function inspectAdbIdentity(dataDir: string, adbPath: string) {
  const directory = path.join(dataDir, '.android');
  const filename = path.join(directory, 'adbkey');
  checkDirectory(directory);
  if (!existsSync(filename)) {
    if (existsSync(`${filename}.pub`))
      throw new Error('ADB public key exists without its private key; restore the matching private key');
    return { directory, initialized: false };
  }
  const identity = privateKey(filename);
  const publicValue = await publicKey(adbPath, filename, adbEnvironment(dataDir));
  checkPublicKey(`${filename}.pub`, publicValue);
  return {
    directory,
    initialized: true,
    fingerprint: identity.fingerprint,
    publicKeyPresent: existsSync(`${filename}.pub`),
  };
}

export async function prepareAdbIdentity(dataDir: string, adbPath: string, source?: string) {
  const directory = path.join(dataDir, '.android');
  const filename = path.join(directory, 'adbkey');
  checkDirectory(directory);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkDirectory(directory);
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  const temporary = mkdtempSync(path.join(directory, '.init-'));
  let created = false;
  try {
    const environment = adbEnvironment(dataDir);
    const staged = path.join(temporary, 'adbkey');
    if (!existsSync(filename)) {
      if (existsSync(`${filename}.pub`))
        throw new Error('ADB public key exists without its private key; restore the matching private key');
      if (source) {
        writeFileSync(staged, privateKey(source).pem, { flag: 'wx', mode: 0o600 });
      } else {
        try {
          await promisify(execFile)(adbPath, ['keygen', staged], {
            env: environment,
            timeout: 15_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          });
        } catch {
          throw new Error('Unable to generate ADB identity; check ADB_PATH and DATA_DIR permissions');
        }
      }
      privateKey(staged);
      const candidatePublic = await publicKey(adbPath, staged, environment);
      if (source) checkPublicKey(`${source}.pub`, candidatePublic);
      if (process.platform !== 'win32') chmodSync(staged, 0o600);
      try {
        linkSync(staged, filename);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const identity = privateKey(filename);
    if (source && privateKey(source).fingerprint !== identity.fingerprint)
      throw new Error('A different ADB identity already exists; back it up and migrate explicitly');
    const publicValue = await publicKey(adbPath, filename, environment);
    if (source) checkPublicKey(`${source}.pub`, publicValue);
    checkPublicKey(`${filename}.pub`, publicValue);
    if (!existsSync(`${filename}.pub`)) {
      const stagedPublic = path.join(temporary, 'public');
      writeFileSync(stagedPublic, `${publicValue}\n`, { flag: 'wx', mode: 0o600 });
      try {
        linkSync(stagedPublic, `${filename}.pub`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        checkPublicKey(`${filename}.pub`, publicValue);
      }
    }
    if (process.platform !== 'win32') {
      chmodSync(filename, 0o600);
      chmodSync(`${filename}.pub`, 0o600);
    }
    return { directory, fingerprint: identity.fingerprint, created };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
