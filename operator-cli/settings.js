const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDirectory = process.platform === 'win32' ? process.env.APPDATA || os.homedir() : os.homedir();
const deviceDirectory = process.env.YCLJ_OPERATOR_DEVICE_DIR || path.join(dataDirectory, 'yclj-operator');
const configFile = path.join(deviceDirectory, 'assist-config.json');
const lanConfigFile = path.join(deviceDirectory, 'lan-config.json');
const lanTokenFile = process.env.YCLJ_OPERATOR_TOKEN_FILE || path.join(deviceDirectory, 'lan-operator-token');
const hostTokenFile = path.join(process.env.YCLJ_HOST_DATA_DIR || path.join(dataDirectory, 'yclj-host-win'), 'operator-token');

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

function readConfig(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadConfiguredUrl(file) {
  const config = readFile(file);
  return config ? JSON.parse(config).serverUrl : '';
}

function getLanToken() {
  return process.env.ADMIN_TOKEN || process.env.YCLJ_ADMIN_TOKEN ||
    (!process.env.YCLJ_OPERATOR_TOKEN_FILE && readFile(hostTokenFile)) || readFile(lanTokenFile);
}

function ensureLanToken() {
  const token = getLanToken();
  if (token) return token;
  const generated = randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(lanTokenFile), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(lanTokenFile, `${generated}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return readFile(lanTokenFile);
  }
  return generated;
}

module.exports = { deviceDirectory, configFile, lanConfigFile, readConfig, loadConfiguredUrl, getLanToken, ensureLanToken };
