import 'reflect-metadata';
import path from 'node:path';
import { settings } from './config';
import { inspectAdbIdentity, prepareAdbIdentity } from './adb-identity';

async function main() {
  const [command, source, ...extra] = process.argv.slice(2);
  if (
    !['init', 'import', 'status'].includes(command) ||
    extra.length ||
    (command === 'import' ? !source : source)
  )
    throw new Error('Usage: adb:identity init | status | import <path-to-adbkey>');
  const identity =
    command === 'status'
      ? await inspectAdbIdentity(settings.dataDir, settings.adbPath)
      : await prepareAdbIdentity(
          settings.dataDir,
          settings.adbPath,
          source ? path.resolve(source) : undefined,
        );
  console.log(JSON.stringify(identity, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'ADB identity operation failed');
  process.exitCode = 1;
});
