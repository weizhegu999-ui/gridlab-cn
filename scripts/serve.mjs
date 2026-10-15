#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HOST = '127.0.0.1';
const ROOT = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..'));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8',
};

function isWithin(directory, target) {
  const pathFromDirectory = relative(directory, target);
  return pathFromDirectory !== '..'
    && !pathFromDirectory.startsWith(`..${sep}`)
    && !isAbsolute(pathFromDirectory);
}

function reply(response, status, message) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  response.end(message);
}

async function handleRequest(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    reply(response, 405, 'Method not allowed\n');
    return;
  }

  let pathname;
  try {
    const rawPath = (request.url ?? '').split('?')[0];
    if (!rawPath.startsWith('/')) throw new Error('Invalid path');
    // Check the request target before URL normalization can remove ".." segments.
    pathname = decodeURIComponent(rawPath);
  } catch {
    reply(response, 400, 'Bad request\n');
    return;
  }

  const segments = pathname.split('/').filter(Boolean);
  if (/[\u0000-\u001f\u007f\\:]/.test(pathname)
    || segments.some(segment => segment.startsWith('.') || /[ .]$/.test(segment))) {
    reply(response, 404, 'Not found\n');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const topLevelFile = pathname === '/index.html' || pathname === '/styles.css';
  const allowedDirectory = ['src', 'assets', 'docs'].find(name => pathname.startsWith(`/${name}/`));
  if (!topLevelFile && !allowedDirectory) {
    reply(response, 404, 'Not found\n');
    return;
  }

  const requestedFile = join(ROOT, pathname.slice(1));
  try {
    const actualFile = await realpath(requestedFile);
    const allowedRoot = allowedDirectory ? join(ROOT, allowedDirectory) : requestedFile;
    // A symlink may not expose files outside its allowed resource directory.
    if (!isWithin(allowedRoot, actualFile)
      || (topLevelFile && relative(requestedFile, actualFile) !== '')
      || !(await stat(actualFile)).isFile()) {
      reply(response, 404, 'Not found\n');
      return;
    }

    const content = await readFile(actualFile);
    response.writeHead(200, {
      'Content-Type': MIME[extname(actualFile).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': content.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    const missing = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code);
    reply(response, missing ? 404 : 500, missing ? 'Not found\n' : 'Server error\n');
  }
}

export function createStaticServer() {
  return createServer((request, response) => {
    handleRequest(request, response).catch(() => {
      if (!response.headersSent) reply(response, 500, 'Server error\n');
      else response.destroy();
    });
  });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createStaticServer();
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      server.on('error', error => console.error(`服务错误：${error.message}`));
      resolve(server);
    });
  });
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: true });
  child.once('error', () => console.error(`无法自动打开浏览器，请手动访问 ${url}`));
  child.unref();
}

async function main() {
  const portText = process.env.PORT ?? '4173';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('PORT 必须是 1～65535 之间的整数。');
  }

  const initialPort = Number(portText);
  for (let offset = 0; offset <= 10 && initialPort + offset <= 65535; offset += 1) {
    const port = initialPort + offset;
    try {
      await listen(port);
      const url = `http://${HOST}:${port}`;
      console.log(`GridLab 已启动：${url}`);
      console.log('按 Ctrl+C 停止服务。');
      if (process.argv.includes('--open')) openBrowser(url);
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('起始端口及之后可尝试的 10 个端口均被占用，请设置其他 PORT。');
}

if (process.argv[1] && relative(fileURLToPath(import.meta.url), resolve(process.argv[1])) === '') {
  main().catch(error => {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
