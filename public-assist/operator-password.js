const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { idPattern } = require('./protocol');

const verifierPattern = /^[a-f0-9]{32}:[a-f0-9]{64}$/;
const lockDuration = 10 * 60_000;
const maximumFailures = 5;

function validPassword(value) {
  return typeof value === 'string' && Array.from(value).length >= 4 && Buffer.byteLength(value) <= 256;
}

function derive(value, salt) {
  return scryptSync(value, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function createVerifier(password) {
  if (!validPassword(password)) throw new Error('口令至少四个字符，且总长度不能超过 256 字节。');
  const salt = randomBytes(16);
  const hash = derive(password, salt);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function parseVerifiers(value) {
  const entries = value ? value.split(',').map(entry => {
    const [id, ...parts] = entry.split(':');
    const verifier = parts.join(':');
    if (!idPattern.test(id) || !verifierPattern.test(verifier)) throw new Error('YCLJ_ASSIST_OPERATOR_PASSWORDS 格式无效');
    return [id, verifier];
  }) : [];
  const verifiers = new Map(entries);
  if (verifiers.size !== entries.length) throw new Error('同一个控制设备配置了多条口令');
  return verifiers;
}

function createPasswordGate(verifiers, now = Date.now) {
  const attempts = new Map();
  return (device, password) => {
    const verifier = verifiers.get(device);
    if (!verifier) return null;
    const current = now();
    let attempt = attempts.get(device);
    if (attempt?.lockedUntil > current) return 'operator_password_locked';
    if (typeof password !== 'string') return 'operator_password_required';
    if (!attempt || attempt.expires <= current) {
      attempt = { failures: 0, expires: current + lockDuration, lockedUntil: 0 };
      attempts.set(device, attempt);
    }
    const [salt, hash] = verifier.split(':').map(part => Buffer.from(part, 'hex'));
    if (validPassword(password) && timingSafeEqual(derive(password, salt), hash)) {
      attempts.delete(device);
      return null;
    }
    if (++attempt.failures >= maximumFailures) {
      attempt.lockedUntil = current + lockDuration;
      attempt.expires = attempt.lockedUntil;
      return 'operator_password_locked';
    }
    return 'operator_password_invalid';
  };
}

module.exports = { createVerifier, parseVerifiers, createPasswordGate };
