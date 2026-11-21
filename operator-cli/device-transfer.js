const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('node:crypto');
const fs = require('node:fs');
const readline = require('node:readline');
const { Writable } = require('node:stream');

function askPassphrase(prompt) {
  if (!process.stdin.isTTY) throw new Error('请在交互终端运行此命令，以便隐藏口令输入。');
  const hiddenOutput = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = readline.createInterface({ input: process.stdin, output: hiddenOutput, terminal: true });
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    input.once('close', () => reject(new Error('已取消。')));
    input.once('SIGINT', () => input.close());
    input.question('', value => {
      resolve(value);
      input.close();
    });
  }).finally(() => process.stderr.write('\n'));
}

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
}

function encryptPayload(payload, passphrase) {
  if (passphrase.length < 12) throw new Error('请为导出文件设置至少 12 个字符的口令。');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return {
      version: 1,
      salt: salt.toString('base64url'),
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      encrypted: encrypted.toString('base64url')
    };
  } finally {
    key.fill(0);
  }
}

function writeBundle(file, payload, passphrase) {
  const bundle = passphrase === undefined
    ? { version: 1, protection: 'none', payload }
    : encryptPayload(payload, passphrase);
  fs.writeFileSync(file, `${JSON.stringify(bundle)}\n`, { mode: 0o600, flag: 'wx' });
}

async function readBundle(file) {
  if (fs.statSync(file).size > 128 * 1024) throw new Error('控制身份导出文件过大。');
  const text = fs.readFileSync(file, 'utf8');
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    throw new Error('无法识别控制身份导出文件。');
  }
  if (bundle?.version === 1 && bundle.protection === 'none' &&
      typeof bundle.payload?.privateKey === 'string' && bundle.payload.config) {
    return bundle.payload;
  }
  if (bundle?.version !== 1 || bundle.protection !== undefined ||
      !['salt', 'iv', 'tag', 'encrypted'].every(field => typeof bundle[field] === 'string') ||
      !/^[\w-]{22}$/.test(bundle.salt) || !/^[\w-]{16}$/.test(bundle.iv) ||
      !/^[\w-]{22}$/.test(bundle.tag) || !/^[\w-]{1,65536}$/.test(bundle.encrypted)) {
    throw new Error('无法识别控制身份导出文件。');
  }
  const passphrase = await askPassphrase('导出文件口令：');
  const key = deriveKey(passphrase, Buffer.from(bundle.salt, 'base64url'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(bundle.tag, 'base64url'));
    const decoded = Buffer.concat([decipher.update(Buffer.from(bundle.encrypted, 'base64url')), decipher.final()]);
    return JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('口令错误，或导出文件已损坏。');
  } finally {
    key.fill(0);
  }
}

module.exports = { askPassphrase, writeBundle, readBundle };
