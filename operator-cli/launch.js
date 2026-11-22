const { createInterface } = require('node:readline');

const command = process.argv[2];
if (command === 'config') {
  const commands = ['init', 'init-lan', 'import-device', 'export-device', 'device-id'];
  if (!commands.includes(process.argv[3])) {
    console.log('config init <服务器地址> | init-lan <局域网地址> | import-device <迁移文件> | export-device <迁移文件> | device-id');
  } else {
    process.argv.splice(2, 1);
    require('../tools/assist-config');
  }
} else if (command || !process.stdin.isTTY) {
  require('./index');
} else {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  prompt.question('请输入对方显示的六位验证码：', pin => {
    prompt.close();
    process.argv.push(pin.trim());
    require('./index');
  });
}
