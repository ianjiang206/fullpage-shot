// Minimal CDP harness (no dependencies): launches headless Chrome with
// --remote-debugging-port, serves the repo root over HTTP, and drives module
// code inside a live page via Runtime.evaluate. Lets probes exercise the
// content modules without loading the extension (Chrome 137+ removed
// --load-extension). Set CHROME_BIN if the binary is not 'google-chrome'.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
};

export async function startServer(port = 8931) {
  const server = http.createServer(async (req, res) => {
    try {
      const file = path.join(REPO_ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

export async function launchChrome(port = 9222) {
  const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-first-run',
    '--window-size=800,600', `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'fps-probe-'))}`,
    'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return chrome;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  chrome.kill();
  throw new Error('chrome devtools endpoint did not come up');
}

export class CdpPage {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #bindings = new Map();
  #eventWaiters = new Map();

  static async open(url, { port = 9222 } = {}) {
    const target = await (await fetch(
      `http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const page = new CdpPage();
    page.#ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      page.#ws.onopen = resolve;
      page.#ws.onerror = reject;
    });
    page.#ws.onmessage = (event) => page.#onMessage(JSON.parse(event.data));
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const loaded = page.waitEvent('Page.loadEventFired');
    await page.send('Page.navigate', { url });
    await loaded;
    return page;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitEvent(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + method)), timeoutMs);
      const list = this.#eventWaiters.get(method) || [];
      list.push((params) => { clearTimeout(timer); resolve(params); });
      this.#eventWaiters.set(method, list);
    });
  }

  // Evaluate an expression in the page; promises are awaited, results return by value.
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception;
      throw new Error('page evaluation failed: ' +
        (detail && detail.description ? detail.description : result.exceptionDetails.text));
    }
    return result.result.value;
  }

  // Expose an async node function to the page as window[name](arg) → Promise.
  async exposeFunction(name, fn) {
    await this.send('Runtime.addBinding', { name });
    this.#bindings.set(name, fn);
    await this.evaluate(`(() => {
      const raw = window[${JSON.stringify(name)}];
      window.__cdpPending = new Map();
      window.__cdpSeq = 0;
      window[${JSON.stringify(name)}] = (arg) => new Promise((resolve) => {
        const id = ++window.__cdpSeq;
        window.__cdpPending.set(id, resolve);
        raw(JSON.stringify({ id, arg }));
      });
    })()`);
  }

  async screenshotDataUrl() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    return 'data:image/png;base64,' + data;
  }

  close() {
    this.#ws.close();
  }

  #onMessage(msg) {
    if (msg.id) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(pending.method + ': ' + msg.error.message));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.bindingCalled') {
      this.#onBindingCalled(msg.params).catch((error) => console.error('binding failed', error));
      return;
    }
    const waiters = this.#eventWaiters.get(msg.method);
    if (waiters && waiters.length) {
      this.#eventWaiters.delete(msg.method);
      for (const resolve of waiters) resolve(msg.params);
    }
  }

  async #onBindingCalled(params) {
    const fn = this.#bindings.get(params.name);
    if (!fn) return;
    const { id, arg } = JSON.parse(params.payload);
    const result = await fn(arg);
    const json = JSON.stringify(result ?? null);
    await this.evaluate(`(() => {
      const resolve = window.__cdpPending.get(${id});
      window.__cdpPending.delete(${id});
      resolve(JSON.parse(${JSON.stringify(json)}));
    })()`);
  }
}
