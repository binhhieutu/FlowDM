'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launchFirefox({ directory, executable, geckodriver, downloadDirectory, extensionId, uuid }) {
  await fs.mkdir(downloadDirectory, { recursive: true });
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(geckodriver, ['--host', '127.0.0.1', '--port', String(port), '--profile-root', directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', chunk => { log = (log + chunk).slice(-64000); }); child.stderr.on('data', chunk => { log = (log + chunk).slice(-64000); });
  let failure; child.on('error', error => { failure = error; }); let sessionId;
  const base = `http://127.0.0.1:${port}`;
  async function command(method, route, body) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || data.value?.error) throw Error(`Firefox WebDriver ${method} ${route}: ${data.value?.message || response.status}`);
    return data.value;
  }
  try {
    const deadline = Date.now() + 15000;
    while (true) {
      if (failure) throw failure;
      try { await command('GET', '/status'); break; } catch (error) { if (Date.now() >= deadline) throw error; await wait(100); }
    }
    const session = await command('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { binary: executable, args: ['-headless'], prefs: { 'browser.download.folderList': 2, 'browser.download.dir': downloadDirectory, 'browser.download.useDownloadDir': true, 'browser.helperApps.neverAsk.saveToDisk': 'application/octet-stream,video/mp2t', 'browser.download.always_ask_before_handling_new_types': false, 'extensions.webextensions.uuids': JSON.stringify({ [extensionId]: uuid }) } } } } });
    sessionId = session.sessionId;
    const api = (method, route, body) => command(method, '/session/' + sessionId + route, body);
    return {
      version: session.capabilities.browserVersion,
      install: extensionPath => api('POST', '/moz/addon/install', { path: extensionPath, temporary: true }),
      navigate: url => api('POST', '/url', { url }),
      handles: () => api('GET', '/window/handles'),
      switchTo: handle => api('POST', '/window', { handle }),
      click: async selector => {
        const element = await api('POST', '/element', { using: 'css selector', value: selector });
        await api('POST', '/element/' + element['element-6066-11e4-a52e-4f735466cecf'] + '/click', {});
      },
      evaluate: (fn, ...args) => api('POST', '/execute/sync', { script: 'return (' + fn.toString() + ')(...arguments)', args }),
      screenshot: async filename => fs.writeFile(filename, Buffer.from(await api('GET', '/screenshot'), 'base64')),
      close: async () => { try { await api('DELETE', ''); } finally { child.kill(); await fs.writeFile(path.join(directory, 'geckodriver.log'), log); } },
      log: () => log
    };
  } catch (error) {
    if (sessionId) await command('DELETE', '/session/' + sessionId).catch(() => {});
    child.kill(); await fs.writeFile(path.join(directory, 'geckodriver.log'), log); throw error;
  }
}
module.exports = { launchFirefox };
