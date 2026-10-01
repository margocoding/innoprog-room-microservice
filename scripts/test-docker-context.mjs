import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Exercise Docker's own ignore semantics using synthetic files only. Never
// copy the repository context or read any actual environment/secret file.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'room-docker-context-'));
const context = join(temporary, 'context');
const output = join(temporary, 'output');
const excluded = [
  '.env', '.env.production', '.env.local', 'prisma/.env',
  'deploy/.env', 'deploy/.env.production',
  'secrets/token', '.secrets/token', 'deploy/secrets/token',
  'deploy/credentials/token', 'secrets/.env.example',
  'deploy/secrets/.env.template', 'deploy/credentials/.env.example',
];
const included = ['.env.example', '.env.template', 'deploy/.env.example', 'src/main.ts'];

try {
  mkdirSync(context);
  copyFileSync(join(root, '.dockerignore'), join(context, '.dockerignore'));
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /\n');
  for (const path of [...excluded, ...included]) {
    const target = join(context, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'synthetic context contract fixture\n');
  }
  execFileSync('docker', ['build', '--output', `type=local,dest=${output}`, context], {
    stdio: 'inherit',
  });
  for (const path of excluded) {
    assert.equal(existsSync(join(output, path)), false, `${path} entered Docker context`);
  }
  for (const path of included) {
    assert.equal(existsSync(join(output, path)), true, `${path} was unexpectedly excluded`);
  }
  console.log('Docker context excludes runtime secrets and preserves source/templates');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
