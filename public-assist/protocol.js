const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const { BlockList, isIP } = require('node:net');
const path = require('node:path');

const INVITE_TTL = 5 * 60_000;
const SIGNAL_LIMIT = 64 * 1024;
const DATA_LIMIT = 64 * 1024;
const idPattern = /^[A-Za-z0-9_-]{43}$/;
const pinPattern = /^\d{6}$/;
const sessionPattern = /^[a-f0-9]{32}$/;
const publicKeyPattern = /^[A-Za-z0-9_-]{59}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function getIdentity(directory) {
  const file = path.join(directory, 'assist-identity.pem');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    try {
      fs.linkSync(temp, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      fs.unlinkSync(temp);
    }
  }
  return readIdentity(fs.readFileSync(file));
}

function readIdentity(pem) {
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('无效的协助设备私钥');
  return { privateKey, key: publicKey.toString('base64url'), id: digest(publicKey) };
}

function signalUrl(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'wss:' || (url.protocol === 'ws:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/assist') {
    throw new Error('公网协助地址应使用 wss://，并以 /assist 结尾');
  }
  return url.href;
}

function isPublicAddress(value) {
  return new URL(value).pathname === '/assist';
}

const lanAddresses = new BlockList();
lanAddresses.addSubnet('10.0.0.0', 8);
lanAddresses.addSubnet('100.64.0.0', 10);
lanAddresses.addSubnet('127.0.0.0', 8);
lanAddresses.addSubnet('169.254.0.0', 16);
lanAddresses.addSubnet('172.16.0.0', 12);
lanAddresses.addSubnet('192.168.0.0', 16);
lanAddresses.addAddress('::1', 'ipv6');
lanAddresses.addSubnet('fc00::', 7, 'ipv6');
lanAddresses.addSubnet('fe80::', 10, 'ipv6');

function isLanAddress(address, family) {
  return lanAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

function lanRelayOptions(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const message = '旧连接协议仅支持本机或私网地址。公网协助请使用以 /assist 结尾的 wss:// 地址。';
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (family && !isLanAddress(host, family))) {
    throw new Error(message);
  }
  return {
    // Validate the DNS answers used by the socket so a second lookup cannot change the destination.
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { ...options, all: true }, (error, answers) => {
        if (error) return callback(error);
        const allowed = answers.filter(({ address, family }) => isLanAddress(address, family));
        if (!allowed.length) return callback(new Error(message));
        if (options.all) return callback(null, allowed);
        callback(null, allowed[0].address, allowed[0].family);
      });
    }
  };
}

function createPinOffer(url, device, previousPin) {
  let pin;
  do { pin = String(crypto.randomInt(1_000_000)).padStart(6, '0'); } while (pin === previousPin);
  return { url: signalUrl(url), device, route: crypto.randomBytes(32).toString('base64url'),
    pin, expires: Date.now() + INVITE_TTL };
}

function makeExchangeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { privateKey, key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
}

function readExchangeKey(key) {
  if (typeof key !== 'string' || !publicKeyPattern.test(key)) throw new Error('Invalid exchange key');
  const publicKey = crypto.createPublicKey({ key: Buffer.from(key, 'base64url'), type: 'spki', format: 'der' });
  if (publicKey.asymmetricKeyType !== 'x25519') throw new Error('Invalid exchange key type');
  return publicKey;
}

function pinSecret(exchange, remoteKey, offer, session, operatorId) {
  const shared = crypto.diffieHellman({ privateKey: exchange.privateKey, publicKey: readExchangeKey(remoteKey) });
  const context = Buffer.from(JSON.stringify(['yclj/pin/1', offer.pin, offer.device, operatorId, session]));
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(offer.route, 'base64url'), context, 32)).toString('base64url');
}

function createInvite(url, device) {
  const invite = { url: signalUrl(url), device, secret: crypto.randomBytes(32).toString('base64url'), expires: Date.now() + INVITE_TTL };
  return { invite, text: `yclj1.${Buffer.from(JSON.stringify(invite)).toString('base64url')}` };
}

function readInvite(text) {
  if (typeof text !== 'string' || !/^yclj1\.[A-Za-z0-9_-]{1,2048}$/.test(text)) throw new Error('公网邀请格式无效');
  let invite;
  try { invite = JSON.parse(Buffer.from(text.slice(6), 'base64url').toString()); } catch { throw new Error('公网邀请格式无效'); }
  if (!invite || typeof invite.device !== 'string' || !idPattern.test(invite.device) ||
      typeof invite.secret !== 'string' || !idPattern.test(invite.secret) ||
      !Number.isSafeInteger(invite.expires) || invite.expires <= Date.now() || invite.expires > Date.now() + INVITE_TTL + 60_000) {
    throw new Error('公网邀请无效或已过期');
  }
  invite.url = signalUrl(invite.url);
  return invite;
}

function inviteRoute(invite) {
  return invite.route || digest(`yclj/route/1:${invite.secret}`);
}

function signedBytes(message) {
  return Buffer.from(JSON.stringify(['yclj/assist/1', message.op, message.route, message.session,
    message.seq, message.key, message.body]));
}

function inviteProof(bytes, invite) {
  return crypto.createHmac('sha256', Buffer.from(invite.secret, 'base64url')).update(bytes).digest();
}

function signSignal(identity, invite, op, session, seq, body) {
  const message = { op, route: inviteRoute(invite), session, seq, key: identity.key, body };
  const bytes = signedBytes(message);
  message.sig = crypto.sign(null, bytes, identity.privateKey).toString('base64url');
  message.proof = invite.secret ? inviteProof(bytes, invite).toString('base64url') : null;
  return message;
}

function verifySignal(message, invite) {
  if (!message || !['op', 'route', 'session', 'key', 'sig'].every(field => typeof message[field] === 'string') ||
      !idPattern.test(message.route) || !sessionPattern.test(message.session) || !Number.isSafeInteger(message.seq) || message.seq < 0 ||
      !publicKeyPattern.test(message.key) || !signaturePattern.test(message.sig)) return null;
  const discovery = ['register_pin', 'lookup_pin'].includes(message.op);
  if (discovery ? message.proof !== null : typeof message.proof !== 'string' || !idPattern.test(message.proof)) return null;
  try {
    const bytes = signedBytes(message);
    if (invite && (message.route !== inviteRoute(invite) ||
        !crypto.timingSafeEqual(inviteProof(bytes, invite), Buffer.from(message.proof, 'base64url')))) return null;
    const der = Buffer.from(message.key, 'base64url');
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, bytes, key, Buffer.from(message.sig, 'base64url'))) return null;
    return digest(der);
  } catch {
    return null;
  }
}

const screenQualities = {
  economy: { width: 960, height: 540, fps: 8, bitrate: 350_000 },
  standard: { width: 1280, height: 720, fps: 15, bitrate: 900_000 },
  clear: { width: 1920, height: 1080, fps: 15, bitrate: 1_800_000 }
};

function isScreenQuality(value) {
  return typeof value === 'string' && Object.hasOwn(screenQualities, value);
}

function operationAllowed(message, fromOperator, sessionId) {
  if (message?.session_id !== sessionId) return false;
  if (message.type === 'exec') {
    return typeof message.payload === 'string' && (fromOperator ? message.stream === 'stdin' : ['stdout', 'stderr'].includes(message.stream));
  }
  if (!fromOperator) return message.type === 'session' && ['shell_exit', 'screen_started', 'screen_stopped'].includes(message.action);
  if (message.type === 'session') return message.action === 'screen_quality' && isScreenQuality(message.quality);
  if (message.type !== 'ui') return false;
  if (message.action === 'clear') return true;
  if (['status', 'update_status'].includes(message.action)) return typeof message.data === 'string';
  return message.action === 'plan' && Array.isArray(message.data) && message.data.every(item => typeof item === 'string');
}

module.exports = { INVITE_TTL, SIGNAL_LIMIT, DATA_LIMIT, idPattern, pinPattern,
  getIdentity, readIdentity, signalUrl, isPublicAddress, lanRelayOptions, createInvite, createPinOffer, makeExchangeKey, readExchangeKey, pinSecret,
  readInvite, inviteRoute, signSignal, verifySignal, operationAllowed, screenQualities, isScreenQuality };
