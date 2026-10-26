'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { domainToASCII } = require('node:url');
const context = new AsyncLocalStorage();
const gateways = new Map();
// Three N16 DASH jobs can each use two gateway legs per fragment (four
// owned sockets). Leave bounded headroom for metadata and teardown overlap.
const HANDSHAKE_MS = 10000, MAX_SOCKETS = 512;
function failure(code = 'PROXY_CONNECTION') {
  const error = Error(code === 'PROXY_AUTH' ? 'Proxy authentication failed' : code === 'PROXY_TIMEOUT' ? 'Proxy connection timed out' : 'Proxy connection failed');
  error.code = code; return error;
}
function hostname(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || /[\s/@?#\\\u0000-\u001f\u007f]/.test(value)) throw Error('Invalid proxy hostname');
  const raw = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (net.isIP(raw)) return raw;
  const host = domainToASCII(raw);
  if (!host || host.length > 253 || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw Error('Invalid proxy hostname');
  return host.toLowerCase();
}
function normalizeProxy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['type', 'host', 'port', 'username', 'password'].includes(key))) throw Error('Invalid proxy settings');
  if (!['http', 'socks5'].includes(input.type) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw Error('Invalid proxy type or port');
  const config = { type: input.type, host: hostname(input.host), port: input.port };
  if (input.username !== undefined || input.password !== undefined) {
    if (typeof input.username !== 'string' || !input.username || typeof input.password !== 'string' || (input.type === 'socks5' && !input.password) || /[:\u0000-\u001f\u007f]/.test(input.username) || /[\u0000-\u001f\u007f]/.test(input.password)
      || Buffer.byteLength(input.username) > 255 || Buffer.byteLength(input.password) > 255) throw Error('Invalid proxy credentials');
    config.username = input.username; config.password = input.password;
  }
  return config;
}
function targetUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 32768) throw Error('Proxy supports HTTP/HTTPS URLs without embedded credentials');
  url.hash = '';
  return url;
}
function authority(target) { return `${net.isIP(target.host) === 6 ? '[' + target.host + ']' : target.host}:${target.port}`; }
function connectTarget(value) {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw Error('Invalid CONNECT destination');
  return { host: hostname(match[1]), port: Number(match[2]) };
}
const basic = (username, password) => 'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64');
function endpointUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || !url.username || !url.password) throw Error('Invalid loopback proxy endpoint');
  return url;
}
function withProxy(endpoint, callback) { if (endpoint !== null) endpointUrl(endpoint); return context.run(endpoint, callback); }
function currentProxy() { return context.getStore() ?? null; }
// Private app integration only: no renderer/native API exposes registration.
// The DASH relay owns its exact port; resources behind it still use the proxy.
function registerLocalRelay(endpoint, relayUrl) {
  const gateway = gateways.get(endpointUrl(endpoint).href), relay = targetUrl(relayUrl);
  if (!gateway || relay.protocol !== 'http:' || relay.hostname !== '127.0.0.1' || !relay.port) throw Error('Invalid app relay registration');
  const key = '127.0.0.1:' + relay.port;
  if (!gateway.has(key) && gateway.size >= 32) throw Error('App relay limit reached');
  gateway.set(key, (gateway.get(key) || 0) + 1); let disposed = false;
  return () => { if (disposed) return; disposed = true; const count = gateway.get(key) || 0; if (count <= 1) gateway.delete(key); else gateway.set(key, count - 1); };
}
class SocketReader {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.waiter = null;
    this.onData = chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); };
    this.onError = () => this.reject(failure());
    socket.on('data', this.onData); socket.on('error', this.onError); socket.on('end', this.onError); socket.on('close', this.onError);
  }
  reject(error) { if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter.reject(error); } }
  drain() {
    const waiter = this.waiter; if (!waiter) return;
    const length = waiter.header ? this.buffer.indexOf('\r\n\r\n') + 4 : waiter.length;
    if (waiter.header && this.buffer.length > 65536) return this.reject(failure());
    if (waiter.header && length < 4 || this.buffer.length < length) return;
    this.waiter = null; const value = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length); waiter.resolve(value);
  }
  read(length) { return this.next({ length }); }
  header() { return this.next({ header: true }); }
  next(options) { return new Promise((resolve, reject) => { this.waiter = { ...options, resolve, reject }; this.drain(); this.socket.resume(); }); }
  finish() {
    this.socket.pause(); this.socket.removeListener('data', this.onData); this.socket.removeListener('error', this.onError);
    this.socket.removeListener('end', this.onError); this.socket.removeListener('close', this.onError);
    if (this.buffer.length && !this.socket.destroyed) this.socket.unshift(this.buffer); this.buffer = Buffer.alloc(0);
  }
}
async function dial(config, own, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: config.host, port: config.port });
    if (!own(socket)) { reject(failure()); return; }
    const abort = () => socket.destroy(failure()); signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(HANDSHAKE_MS, () => socket.destroy(failure('PROXY_TIMEOUT')));
    socket.once('connect', () => resolve(socket)); socket.once('error', () => reject(failure()));
    socket.once('close', () => signal?.removeEventListener('abort', abort));
  });
}
function socksAddress(host) {
  if (net.isIP(host) === 4) return Buffer.from([1, ...host.split('.').map(Number)]);
  if (net.isIP(host) === 6) {
    let expanded = host;
    if (expanded.includes('.')) {
      const at = expanded.lastIndexOf(':'), bytes = expanded.slice(at + 1).split('.').map(Number);
      expanded = expanded.slice(0, at + 1) + (bytes[0] * 256 + bytes[1]).toString(16) + ':' + (bytes[2] * 256 + bytes[3]).toString(16);
    }
    const halves = expanded.split('::'), left = halves[0].split(':').filter(Boolean), right = (halves[1] || '').split(':').filter(Boolean);
    const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    const result = Buffer.alloc(17); result[0] = 4; words.forEach((word, i) => result.writeUInt16BE(parseInt(word, 16), 1 + i * 2)); return result;
  }
  const name = Buffer.from(host); if (!name.length || name.length > 255) throw failure();
  return Buffer.concat([Buffer.from([3, name.length]), name]);
}
async function socksHandshake(socket, config, target, reader) {
  socket.write(Buffer.from([5, 1, config.username === undefined ? 0 : 2]));
  const greeting = await reader.read(2);
  if (greeting[0] !== 5 || greeting[1] !== (config.username === undefined ? 0 : 2)) throw failure('PROXY_AUTH');
  if (greeting[1] === 2) {
    const user = Buffer.from(config.username), password = Buffer.from(config.password);
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
    const reply = await reader.read(2); if (reply[0] !== 1 || reply[1] !== 0) throw failure('PROXY_AUTH');
  }
  const port = Buffer.alloc(2); port.writeUInt16BE(target.port);
  // Names are sent intact to upstream DNS; literals use their protocol IP type.
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(target.host), port]));
  const response = await reader.read(4);
  if (response[0] !== 5 || response[1] !== 0 || response[2] !== 0) throw failure();
  if (response[3] === 1) await reader.read(6);
  else if (response[3] === 4) await reader.read(18);
  else if (response[3] === 3) { const length = (await reader.read(1))[0]; if (!length) throw failure(); await reader.read(length + 2); }
  else throw failure();
}
async function upstreamTunnel(config, target, own, signal) {
  const socket = await dial(config, own, signal), reader = new SocketReader(socket);
  try {
    if (config.type === 'socks5') await socksHandshake(socket, config, target, reader);
    else {
      const destination = authority(target);
      socket.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n${config.username === undefined ? '' : 'Proxy-Authorization: ' + basic(config.username, config.password) + '\r\n'}\r\n`);
      const header = (await reader.header()).toString('latin1'), match = /^HTTP\/1\.[01] (\d{3})\b/.exec(header);
      if (!match || match[1] !== '200') throw failure(match?.[1] === '407' ? 'PROXY_AUTH' : 'PROXY_CONNECTION');
    }
    socket.setTimeout(60000, () => socket.destroy()); return socket;
  } catch (error) { socket.destroy(); throw error; }
  finally { reader.finish(); }
}
function originHeaders(headers, host) {
  const result = Object.fromEntries(Object.entries(headers).filter(([key]) => !['proxy-authorization', 'proxy-connection', 'connection'].includes(key.toLowerCase())));
  return { ...result, host, connection: 'close' };
}
async function createProxy(input) {
  const config = normalizeProxy(input), sockets = new Set(), localRelays = new Map(); let closed = false;
  const token = randomBytes(32).toString('hex'), authorization = basic('flowdm', token);
  function own(socket) {
    if (closed || sockets.size >= MAX_SOCKETS) { socket.destroy(); return false; }
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return true;
  }
  const authorized = value => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(authorization) && timingSafeEqual(Buffer.from(value), Buffer.from(authorization));
  const server = http.createServer({ maxHeaderSize: 65536 }, (request, response) => {
    if (!authorized(request.headers['proxy-authorization'])) { response.writeHead(407).end('Proxy authorization required'); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end('Unsupported proxy method'); return; }
    let target; try { target = targetUrl(request.url); if (target.protocol !== 'http:') throw Error(); } catch { response.writeHead(400).end('Invalid proxy destination'); return; }
    void forwardHttp(request, response, target).catch(() => { if (!response.headersSent) response.writeHead(502).end('Proxy connection failed'); else response.destroy(); });
  });
  async function forwardHttp(request, response, target) {
    const controller = new AbortController(); response.once('close', () => controller.abort());
    const headers = originHeaders(request.headers, target.host);
    let agent, options;
    if (localRelays.has(target.hostname + ':' + Number(target.port || 80))) options = { host: '127.0.0.1', port: Number(target.port), path: target.pathname + target.search, method: request.method, headers, agent: false };
    else if (config.type === 'http') options = { host: config.host, port: config.port, path: target.href, method: request.method, headers: { ...headers, ...(config.username === undefined ? {} : { 'proxy-authorization': basic(config.username, config.password) }) }, agent: false };
    else {
      const socket = await upstreamTunnel(config, { host: hostname(target.hostname), port: Number(target.port || 80) }, own, controller.signal);
      agent = new http.Agent({ keepAlive: false }); agent.createConnection = () => socket;
      options = { host: target.hostname, port: Number(target.port || 80), path: target.pathname + target.search, method: request.method, headers, agent };
    }
    const outgoing = http.request({ ...options, signal: controller.signal }, upstream => {
      if (upstream.statusCode === 407) { upstream.destroy(); response.writeHead(407).end('Proxy authentication failed'); return; }
      const clean = originHeaders(upstream.headers, target.host); delete clean.host;
      response.writeHead(upstream.statusCode, clean); upstream.pipe(response);
      upstream.on('error', () => response.destroy());
    });
    outgoing.on('socket', socket => { if (!sockets.has(socket)) own(socket); socket.resume(); });
    outgoing.setTimeout(HANDSHAKE_MS, () => outgoing.destroy(failure('PROXY_TIMEOUT')));
    outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502).end('Proxy connection failed'); else response.destroy(); });
    response.once('close', () => { outgoing.destroy(); agent?.destroy(); }); request.pipe(outgoing);
  }
  server.on('connection', socket => { if (own(socket)) socket.setTimeout(60000, () => socket.destroy()); });
  server.on('connect', (request, client, head) => {
    if (!authorized(request.headers['proxy-authorization'])) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n'); return; }
    let target; try { target = connectTarget(request.url); } catch { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const controller = new AbortController(); client.once('close', () => controller.abort());
    const opening = localRelays.has(target.host + ':' + target.port)
      ? dial(target, own, controller.signal).then(socket => { socket.setTimeout(60000, () => socket.destroy()); return socket; })
      : upstreamTunnel(config, target, own, controller.signal);
    opening.then(remote => {
      if (client.destroyed) { remote.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head);
      client.pipe(remote); remote.pipe(client); client.once('close', () => remote.destroy()); remote.once('close', () => client.destroy());
    }).catch(error => { if (!client.destroyed) client.end(`HTTP/1.1 ${error.code === 'PROXY_AUTH' ? '407 Proxy Authentication Required' : '502 Bad Gateway'}\r\nConnection: close\r\n\r\n`); });
  });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  server.headersTimeout = HANDSHAKE_MS; server.requestTimeout = HANDSHAKE_MS; server.maxConnections = MAX_SOCKETS;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://flowdm:${token}@127.0.0.1:${server.address().port}`; gateways.set(endpointUrl(url).href, localRelays);
  return { url, configInfo: { type: config.type, host: config.host, port: config.port, authenticated: config.username !== undefined },
    async close() { if (closed) return; closed = true; gateways.delete(endpointUrl(url).href); localRelays.clear(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
function gatewayTunnel(endpoint, target, signal) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: endpoint.hostname, port: endpoint.port, method: 'CONNECT', path: authority(target), headers: { host: authority(target), 'proxy-authorization': basic(decodeURIComponent(endpoint.username), decodeURIComponent(endpoint.password)) }, signal, agent: false });
    request.setTimeout(HANDSHAKE_MS, () => request.destroy(failure('PROXY_TIMEOUT')));
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(failure(response.statusCode === 407 ? 'PROXY_AUTH' : 'PROXY_CONNECTION')); return; }
      if (head.length) socket.unshift(head); resolve(socket);
    });
    request.once('error', reject); request.end();
  });
}
function requestViaProxy(value, options = {}, callback) {
  const target = targetUrl(value), selected = currentProxy();
  if (!selected) return (target.protocol === 'https:' ? https : http).request(target, options, callback);
  const endpoint = endpointUrl(selected), headers = originHeaders(options.headers || {}, target.host);
  if (target.protocol === 'http:') return http.request({ ...options, host: endpoint.hostname, hostname: endpoint.hostname, port: endpoint.port, protocol: 'http:', path: target.href, headers: { ...headers, 'proxy-authorization': basic(decodeURIComponent(endpoint.username), decodeURIComponent(endpoint.password)) }, agent: false }, callback);
  if (options.rejectUnauthorized === false) throw Error('TLS certificate validation cannot be disabled');
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (connectionOptions, done) => {
    gatewayTunnel(endpoint, { host: hostname(target.hostname), port: Number(target.port || 443) }, options.signal).then(socket => {
      const secure = tls.connect({ ...connectionOptions, socket, host: hostname(target.hostname), servername: net.isIP(hostname(target.hostname)) ? undefined : hostname(target.hostname), rejectUnauthorized: true });
      const failed = error => { secure.destroy(); done(error); };
      secure.once('error', failed); secure.once('secureConnect', () => { secure.removeListener('error', failed); done(null, secure); });
    }, done);
  };
  const request = https.request(target, { ...options, headers, agent }, callback);
  request.once('close', () => agent.destroy()); return request;
}
module.exports = { normalizeProxy, createProxy, withProxy, currentProxy, requestViaProxy, registerLocalRelay };
