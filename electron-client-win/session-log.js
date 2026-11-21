const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const clock = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' });
const channel = { 'terminal-command': '[cmd] ', 'terminal-output': '', 'terminal-error': '[stderr] ' };

function openSessionLog(userData, relayUrl) {
  const directory = path.join(userData, 'session-logs');
  const timestamp = clock.format(new Date()).replace(' ', '_').replaceAll(':', '-');
  const filename = `远程帮助-${timestamp}-${randomBytes(3).toString('hex')}.log`;
  const pendingPath = path.join(directory, filename);
  fs.mkdirSync(directory, { recursive: true });
  const file = fs.openSync(pendingPath, 'wx');
  let buffer = `\uFEFF远程帮助 · 详细操作记录\r\n开始时间 ${clock.format(new Date())}\r\n连接地址 ${relayUrl}\r\n\r\n`;
  let writeError = false;

  function flush() {
    if (writeError) return;
    try {
      fs.writeFileSync(file, buffer, 'utf8');
      buffer = '';
    } catch {
      writeError = true;
    }
  }

  return {
    append(entry) {
      if (writeError) return;
      const timestamp = clock.format(new Date(entry.ts));
      const prefix = channel[entry.kind] ?? '';
      buffer += `${timestamp}  ${prefix}${entry.text.trimEnd().replace(/\r\n|\r|\n/g, '\r\n')}\r\n`;
      if (buffer.length >= 8192) flush();
    },
    finish(getDesktop) {
      flush();
      try { fs.closeSync(file); } catch { writeError = true; }
      if (writeError) return { path: pendingPath, message: '日志未完整写入，已保留部分记录', warning: true };
      let desktopFile;
      try {
        desktopFile = path.join(getDesktop(), filename);
        fs.copyFileSync(pendingPath, desktopFile, fs.constants.COPYFILE_EXCL);
      } catch {
        return { path: pendingPath, message: '桌面暂不可用，日志已保存在本机', warning: true };
      }
      try { fs.unlinkSync(pendingPath); } catch { /* The desktop copy is complete. */ }
      return { path: desktopFile, message: '详细日志已保存到桌面' };
    }
  };
}

module.exports = { openSessionLog };
