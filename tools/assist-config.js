#!/usr/bin/env node

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { isIP } = require('node:net');
const path = require('node:path');
const { getIdentity, readIdentity, idPattern, lanRelayOptions, signalUrl } = require('../public-assist/protocol');
const { createVerifier } = require('../public-assist/operator-password');
const { deviceDirectory, configFile, lanConfigFile, readConfig, ensureLanToken } = require('../operator-cli/settings');
const { askPassphrase, writeBundle, readBundle } = require('../operator-cli/device-transfer');

const usage = [
  'yclj-config device-id',
  'yclj-config init wss://assist.example.com/assist [设备ID,设备ID] [--extra-password]',
  'yclj-config server-env [配置文件]',
  'yclj-config build [配置文件]',
  'yclj-config export-device 文件路径 [--no-passphrase]',
  'yclj-config import-device 文件路径',
  'yclj-config init-lan [ws://本机局域网IP:18081]',
  'yclj-config serve-lan [配置文件]',
  'yclj-config build-lan [配置文件]',
  'yclj-config guide [public|lan]'
].join('\n');

const publicGuide = [
  '已经有服务器：执行 init 设置地址，再在 Windows 上执行 build 生成安装包。',
  '首次部署：执行 init 和 server-env，按 docs/quick-start.md 把设置传到自己的 Linux 云主机并启动服务。',
  '云安全组和主机防火墙入站允许 TCP 443、UDP 3478、TCP 5349、UDP 49170–49185。',
  'TCP 80、18082、3389 和局域网服务端口不需要对公网开放。SSH 22 先验证管理员的受限入口能登录，再收紧原规则。',
  '朋友点「开始」提供六位码。控制端用 node operator-cli/index.js 123456 发起连接。'
].join('\n');

const lanGuide = [
  '在本机运行 init-lan，填本机的局域网 IP，端口通常用 18081。同机测试可用 127.0.0.1。',
  '执行 serve-lan 启动本地服务，或直接使用原来的 Windows 主机端。两种方式选一种。',
  '需要其他局域网电脑连接时，只在主机防火墙的私有网络放行该 TCP 端口，限制来源为你的局域网。',
  '在 Windows 上执行 build-lan，发给朋友的安装包预填本地地址，朋友可以修改。',
  '收到六位码后运行 node operator-cli/index.js 123456 --lan。'
].join('\n');

function validateConfig({ serverUrl, operatorIds, requirePassword }) {
  const url = signalUrl(serverUrl);
  if (!url.startsWith('wss://')) throw new Error('部署地址需要使用 wss://。');
  if (!Array.isArray(operatorIds) || !operatorIds.length ||
      operatorIds.some(id => typeof id !== 'string' || !idPattern.test(id))) {
    throw new Error('请填写控制设备的公开 ID，可用英文逗号分隔多个设备。');
  }
  return { serverUrl: url, operatorIds, ...(requirePassword === true ? { requirePassword: true } : {}) };
}

function validateLanConfig({ serverUrl }) {
  const url = new URL(serverUrl);
  if (url.pathname === '/assist') throw new Error('局域网地址请使用原有中继端口。/assist 用于公网协议。');
  lanRelayOptions(url.href);
  return url;
}

function saveConfig(file, config) {
  fs.mkdirSync(deviceDirectory, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

async function buildClient(output, extraMetadata) {
  const { build, Platform, Arch } = require('electron-builder');
  await build({
    projectDir: path.resolve(__dirname, '..'),
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    config: {
      directories: { output: `release-win-client/${output}` },
      extraMetadata
    }
  });
}

async function exportDevice(file, noPassphrase) {
  const config = validateConfig(readConfig(configFile));
  const identity = getIdentity(deviceDirectory);
  if (!config.operatorIds.includes(identity.id)) throw new Error('当前控制身份未列在配置的可信设备中。');
  if (fs.existsSync(file)) throw new Error('导出文件已存在，请换一个文件名。');
  let passphrase;
  if (!noPassphrase) {
    passphrase = await askPassphrase('导出文件口令：');
    if (passphrase !== await askPassphrase('再输一次口令：')) throw new Error('两次口令不一致。');
  }
  const privateKey = identity.privateKey.export({ format: 'pem', type: 'pkcs8' });
  writeBundle(file, { config, privateKey }, passphrase);
  console.log(noPassphrase ? '已免口令导出控制身份和服务器地址。' : '已导出加密的控制身份和服务器地址。');
}

async function importDevice(file) {
  const { config: rawConfig, privateKey } = await readBundle(file);
  const config = validateConfig(rawConfig);
  const identity = readIdentity(privateKey);
  if (!config.operatorIds.includes(identity.id)) throw new Error('导出文件里的身份和配置不匹配。');
  const identityFile = path.join(deviceDirectory, 'assist-identity.pem');
  const hasIdentity = fs.existsSync(identityFile);
  const hasConfig = fs.existsSync(configFile);
  if ((hasIdentity && readIdentity(fs.readFileSync(identityFile)).id !== identity.id) ||
      (hasConfig && validateConfig(readConfig(configFile)).serverUrl !== config.serverUrl)) {
    throw new Error('当前目录已有其他控制身份或服务器配置。用 YCLJ_OPERATOR_DEVICE_DIR 指定一个新目录后再导入。');
  }
  fs.mkdirSync(deviceDirectory, { recursive: true, mode: 0o700 });
  if (!hasIdentity) fs.writeFileSync(identityFile, privateKey, { mode: 0o600, flag: 'wx' });
  if (!hasConfig) fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log('已导入原有控制身份和服务器地址。日常 CLI 可以直接使用六位码连接。');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log(usage);
    return;
  }
  if (command === 'device-id' && !args.length) {
    console.log(getIdentity(deviceDirectory).id);
    return;
  }
  const extraPassword = command === 'init' && args.at(-1) === '--extra-password';
  if (extraPassword) args.pop();
  if (command === 'init' && args.length >= 1 && args.length <= 2) {
    const ids = args[1] ?? getIdentity(deviceDirectory).id;
    const config = validateConfig({
      serverUrl: args[0], operatorIds: ids.split(',').map(id => id.trim()), requirePassword: extraPassword
    });
    if (extraPassword && !config.operatorIds.includes(getIdentity(deviceDirectory).id)) {
      throw new Error('启用额外口令时，当前控制设备的公开 ID 必须在名单里。');
    }
    saveConfig(configFile, config);
    console.log(`已保存配置 ${configFile}`);
    if (extraPassword) console.log('已启用口令提示。下一步用 server-env 设置口令，再把导出的校验设置部署到服务器。');
    console.log(publicGuide);
    return;
  }
  if (command === 'server-env' && args.length <= 1) {
    const { serverUrl, operatorIds, requirePassword } = validateConfig(readConfig(args[0] ?? configFile));
    const { hostname } = new URL(serverUrl);
    let verifier;
    if (requirePassword) {
      const id = getIdentity(deviceDirectory).id;
      if (!operatorIds.includes(id)) throw new Error('请在要启用额外口令的控制电脑上导出服务器设置。');
      const password = await askPassphrase('协助口令：');
      if (password !== await askPassphrase('再输一次口令：')) throw new Error('两次口令不一致。');
      verifier = `${id}:${createVerifier(password)}`;
    }
    console.log(`YCLJ_ASSIST_OPERATOR_IDS=${operatorIds.join(',')}`);
    console.log(`YCLJ_ASSIST_TURN_URLS=turn:${hostname}:3478?transport=udp,turns:${hostname}:5349?transport=tcp`);
    console.log('YCLJ_ASSIST_PORT=18082');
    if (verifier) console.log(`YCLJ_ASSIST_OPERATOR_PASSWORDS=${verifier}`);
    return;
  }
  if (command === 'build' && args.length <= 1) {
    const { serverUrl, operatorIds } = validateConfig(readConfig(args[0] ?? configFile));
    await buildClient('public', { ycljPublicUrl: serverUrl, ycljTrustedOperators: operatorIds.join(',') });
    return;
  }
  if (command === 'export-device' && (args.length === 1 || (args.length === 2 && args[1] === '--no-passphrase'))) {
    await exportDevice(args[0], args[1] === '--no-passphrase');
    return;
  }
  if (command === 'import-device' && args.length === 1) {
    await importDevice(args[0]);
    return;
  }
  if (command === 'init-lan' && args.length <= 1) {
    const url = validateLanConfig({ serverUrl: args[0] ?? 'ws://127.0.0.1:18081' });
    saveConfig(lanConfigFile, { serverUrl: url.href });
    console.log(`已保存局域网配置 ${lanConfigFile}`);
    console.log(lanGuide);
    return;
  }
  if (command === 'serve-lan' && args.length <= 1) {
    const url = validateLanConfig(readConfig(args[0] ?? lanConfigFile));
    const hostname = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'ws:' || !isIP(hostname)) {
      throw new Error('启动本地服务时请用 ws://本机IP:端口。域名或 wss:// 可用于已有局域网代理。');
    }
    process.env.RELAY_HOST = hostname;
    process.env.RELAY_PORT = url.port || '80';
    process.env.ADMIN_TOKEN = ensureLanToken();
    require('../relay/index');
    return;
  }
  if (command === 'build-lan' && args.length <= 1) {
    const url = validateLanConfig(readConfig(args[0] ?? lanConfigFile));
    await buildClient('lan', { ycljLanUrl: url.href });
    return;
  }
  if (command === 'guide' && (!args.length || (args.length === 1 && ['public', 'lan'].includes(args[0])))) {
    console.log(args[0] === 'lan' ? lanGuide : publicGuide);
    return;
  }
  throw new Error(usage);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
