import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../scripts/serve.mjs';

let server;
let port;
const serverScript = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url));

before(async () => {
  server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function get(path, { method = 'GET', targetPort = port } = {}) {
  return new Promise((resolve, reject) => {
    // node:http preserves the raw path, including traversal attempts.
    const outgoing = request({ host: '127.0.0.1', port: targetPort, path, method, agent: false }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.once('error', reject);
      incoming.once('end', () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

test('serves the HTML entry point and correct resource MIME types', async () => {
  const cases = [
    ['/', 'text/html; charset=utf-8'],
    ['/src/engineering.js', 'text/javascript; charset=utf-8'],
    ['/src/engineering.js?v=1', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'text/css; charset=utf-8'],
    ['/assets/favicon.svg', 'image/svg+xml; charset=utf-8'],
    ['/docs/theory.md', 'text/plain; charset=utf-8'],
  ];
  for (const [path, contentType] of cases) {
    const result = await get(path);
    assert.equal(result.status, 200, path);
    assert.equal(result.headers['content-type'], contentType, path);
    assert.equal(result.headers['x-content-type-options'], 'nosniff', path);
    assert.ok(result.body.length > 0, path);
  }
});

test('HEAD returns matching headers without a response body', async () => {
  const full = await get('/index.html');
  const head = await get('/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-type'], full.headers['content-type']);
  assert.equal(head.headers['content-length'], full.headers['content-length']);
  assert.equal(head.body, '');
});

test('rejects raw and encoded traversal, hidden paths, and non-public files', async () => {
  const denied = [
    '/../package.json',
    '/%2e%2e/package.json',
    '/src/../package.json',
    '/src/%2e%2e/package.json',
    '/src/%2e%2e%5cpackage.json',
    '/.git/config',
    '/src/.git/config',
    '/src/.env',
    '/scripts/serve.mjs',
    '/tests/engineering.test.js',
    '/package.json',
    '/README.md',
  ];
  for (const path of denied) {
    const result = await get(path);
    assert.equal(result.status, 404, path);
    assert.equal(result.body, 'Not found\n', path);
  }
});

test('does not list directories or disclose missing-file details', async () => {
  for (const path of ['/src/', '/assets/', '/docs/', '/src/not-a-real-file.js']) {
    const result = await get(path);
    assert.equal(result.status, 404, path);
    assert.equal(result.body, 'Not found\n', path);
  }
});

test('rejects malformed URL encoding and unsupported methods', async () => {
  assert.equal((await get('/%E0%A4%A')).status, 400);
  const result = await get('/', { method: 'POST' });
  assert.equal(result.status, 405);
  assert.equal(result.headers.allow, 'GET, HEAD');
});

test('CLI tries a subsequent port when the requested port is occupied', async () => {
  // The in-process test server already occupies this port.
  const child = spawn(process.execPath, [serverScript], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    const actualPort = await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      const timer = setTimeout(() => reject(new Error(`CLI did not start: ${errors}`)), 10000);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.stderr.on('data', chunk => { errors += chunk.toString(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`CLI exited early (${code}): ${errors}`));
      });
    });
    assert.ok(actualPort > port && actualPort <= Math.min(port + 10, 65535));
    assert.equal((await get('/', { targetPort: actualPort })).status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
});

test('CLI rejects invalid PORT values before starting a server', () => {
  const result = spawnSync(process.execPath, [serverScript], {
    env: { ...process.env, PORT: 'not-a-port' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PORT/);
});
