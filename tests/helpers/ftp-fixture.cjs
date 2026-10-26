'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const assert = require('node:assert/strict');
const { testCertificate } = require('./tls-fixture.cjs');
async function createFtpFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-ftp-test-'));
  const certificates = options.secure ? await testCertificate(root) : null;
  const sockets = new Set(), servers = new Set(), commands = [], transfers = [];
  const state = { body: options.body || Buffer.alloc(128 * 1024, 73), modified: '20261026010000', missingMdtm: false, connections: 0 };
  const ownSocket = socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); return socket; };
  const server = net.createServer(socket => {
    state.connections++; ownSocket(socket); let control = socket, secured = false, loggedIn = false, username = '', rest = 0, buffer = '', dataReady = null;
    const reply = text => { if (!control.destroyed) control.write(text + '\r\n'); };
    async function passive() {
      let accept;
      dataReady = new Promise(resolve => { accept = resolve; });
      const dataServer = secured ? tls.createServer(options.dataCertificates || certificates, socket => accept(ownSocket(socket))) : net.createServer(socket => accept(ownSocket(socket)));
      dataServer.on('tlsClientError', () => {}); dataServer.on('error', () => {}); servers.add(dataServer);
      await new Promise(resolve => dataServer.listen(0, '127.0.0.1', resolve));
      return dataServer.address().port;
    }
    async function sendData(body, start = 0) {
      reply('150 Opening passive data connection');
      const data = await dataReady; let at = start;
      const record = { start, bytes: 0 }; transfers.push(record);
      const timer = setInterval(() => {
        if (data.destroyed) { clearInterval(timer); return; }
        const next = Math.min(body.length, at + (options.chunkBytes || 8192));
        const part = body.subarray(at, next); data.write(part); record.bytes += part.length; at = next;
        if (at >= body.length) { clearInterval(timer); data.end(() => reply('226 Transfer complete')); }
      }, options.delay ?? 5);
      data.once('close', () => clearInterval(timer));
    }
    async function command(line) {
      const space = line.indexOf(' '), verb = (space < 0 ? line : line.slice(0, space)).toUpperCase(), value = space < 0 ? '' : line.slice(space + 1);
      commands.push({ verb, ...(verb === 'PASS' ? {} : { value }) });
      if (verb === 'AUTH' && certificates) {
        reply('234 TLS ready'); control.removeListener('data', consume); secured = true;
        control = ownSocket(new tls.TLSSocket(control, { isServer: true, secureContext: tls.createSecureContext(certificates) }));
        control.on('data', consume); return;
      }
      if (verb === 'USER') { username = value; reply('331 Password required'); return; }
      if (verb === 'PASS') { loggedIn = options.accounts ? Object.hasOwn(options.accounts, username) && value === options.accounts[username].password : username === (options.user || 'anonymous') && value === (options.password || 'guest'); reply(loggedIn ? '230 Logged in' : '530 Login incorrect'); return; }
      if (!loggedIn && verb !== 'QUIT') { reply('530 Login required'); return; }
      if (verb === 'FEAT') { reply('211-Features\r\n UTF8\r\n MLST type*;size*;modify*;\r\n REST STREAM\r\n211 End'); return; }
      if (['OPTS', 'TYPE', 'STRU', 'PBSZ', 'PROT', 'NOOP'].includes(verb)) { reply('200 OK'); return; }
      if (verb === 'PWD') { reply('257 "/"'); return; }
      if (verb === 'SIZE') { reply('213 ' + (options.accounts?.[username]?.body || state.body).length); return; }
      if (verb === 'MDTM') { reply(state.missingMdtm ? '500 MDTM unavailable' : '213 ' + state.modified); return; }
      if (verb === 'EPSV') { reply(options.disableEpsv ? '500 EPSV unsupported' : '229 Entering Extended Passive Mode (|||' + await passive() + '|)'); return; }
      if (verb === 'PASV') { const port = await passive(); reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`); return; }
      if (verb === 'REST') { rest = Number(value); reply('350 Restart accepted'); return; }
      if (verb === 'RETR') { const start = rest; rest = 0; await sendData(options.accounts?.[username]?.body || state.body, start); return; }
      if (verb === 'MLSD' || verb === 'LIST') { await sendData(Buffer.from(`type=file;size=${state.body.length};modify=${state.modified}; ảnh.bin\r\n`)); return; }
      if (verb === 'QUIT') { reply('221 Bye'); control.end(); return; }
      reply('502 Unsupported command');
    }
    function consume(data) {
      buffer += data.toString('utf8');
      for (;;) { const end = buffer.indexOf('\r\n'); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); void command(line).catch(() => control.destroy()); }
    }
    control.on('data', consume); reply('220 FlowDM local fixture');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.add(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-ftp-test-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, state, commands, transfers, cert: certificates?.cert, url: `${options.secure ? 'ftps' : 'ftp'}://127.0.0.1:${server.address().port}/%E1%BA%A3nh.bin`, partialPath: path.join(root, 'download.part') };
}
module.exports = { createFtpFixture };
