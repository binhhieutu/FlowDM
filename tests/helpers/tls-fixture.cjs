'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
async function testCertificate(directory) {
  const keyPath = path.join(directory, 'localhost-test.key'), certPath = path.join(directory, 'localhost-test.crt');
  const executable = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : '/usr/bin/openssl';
  await promisify(execFile)(executable, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 });
  return { key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) };
}
module.exports = { testCertificate };
