const { stripVTControlCharacters } = require('node:util');

function terminalText(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

module.exports = { terminalText };
