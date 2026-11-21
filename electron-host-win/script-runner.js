const { randomBytes } = require('crypto');
const { stripVTControlCharacters } = require('util');

const SCRIPT_LIMIT = 8192;
const OUTPUT_LIMIT = 32768;
const REMOTE_TIMEOUT = 110000;
const RESULT_TIMEOUT = 120000;

function terminalCommands(script, id) {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const variable = `ycljScript_${id}`;
  const chunks = encoded.match(/.{1,768}/g);
  const uploads = chunks.map((chunk, index) =>
    `$global:${variable} ${index ? '+=' : '='} '${chunk}'\r\n\r\n`
  );
  const childCommand = [
    '$enc = [Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = $OutputEncoding = $enc',
    '$ErrorActionPreference = [Management.Automation.ActionPreference]::Stop',
    "& ([ScriptBlock]::Create($enc.GetString([Convert]::FromBase64String('__YCLJ_SCRIPT__'))))"
  ].join('; ');
  const execute = [
    '& {',
    '$ErrorActionPreference = "Stop";',
    '$enc = [Text.UTF8Encoding]::new($false);',
    `$source = $global:${variable}; Remove-Variable -Scope Global -Name '${variable}';`,
    `$marker = 'YCLJ-' + '${id}';`,
    "$result = @{ status = 'finished'; exitCode = $null; stdout = ''; stderr = ''; truncated = $false };",
    'try {',
    '[Console]::WriteLine("PowerShell script:");',
    '[Console]::WriteLine($enc.GetString([Convert]::FromBase64String($source)));',
    '$proc = New-Object Diagnostics.Process;',
    'try {',
    '$proc.StartInfo.FileName = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\\v1.0\\powershell.exe";',
    `$proc.StartInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "${childCommand.replace(/'/g, "''")}"'.Replace('__YCLJ_SCRIPT__', $source);`,
    '$proc.StartInfo.UseShellExecute = $false; $proc.StartInfo.CreateNoWindow = $true;',
    '$proc.StartInfo.RedirectStandardOutput = $proc.StartInfo.RedirectStandardError = $proc.StartInfo.RedirectStandardInput = $true;',
    '$proc.StartInfo.StandardOutputEncoding = $proc.StartInfo.StandardErrorEncoding = $enc;',
    '[void]$proc.Start(); $proc.StandardInput.Close();',
    '$out = $proc.StandardOutput.ReadToEndAsync(); $err = $proc.StandardError.ReadToEndAsync();',
    `if ($proc.WaitForExit(${REMOTE_TIMEOUT})) { $result.exitCode = $proc.ExitCode } else { $result.status = 'timed_out'; if (!$proc.HasExited) { $proc.Kill() } };`,
    `if ($out.Wait(1000)) { $result.stdout = $out.Result.Substring(0, [Math]::Min($out.Result.Length, ${OUTPUT_LIMIT})); $result.truncated = $out.Result.Length -gt ${OUTPUT_LIMIT} } else { $result.truncated = $true };`,
    `if ($err.Wait(1000)) { $result.stderr = $err.Result.Substring(0, [Math]::Min($err.Result.Length, ${OUTPUT_LIMIT})); $result.truncated = $result.truncated -or $err.Result.Length -gt ${OUTPUT_LIMIT} } else { $result.truncated = $true };`,
    '} finally { $proc.Dispose() };',
    "} catch { $result.status = 'runner_error'; $result.stderr = $_.Exception.Message };",
    '$encoded = [Convert]::ToBase64String($enc.GetBytes(($result | ConvertTo-Json -Compress)));',
    '[Console]::WriteLine($marker + ":BEGIN");',
    // Keep each result line below the old client's 120-column terminal width.
    'for ($i = 0; $i -lt $encoded.Length; $i += 96) { [Console]::WriteLine($encoded.Substring($i, [Math]::Min(96, $encoded.Length - $i))) };',
    '[Console]::WriteLine($marker + ":END");',
    'if ($result.stdout) { [Console]::WriteLine($result.stdout) };',
    'if ($result.stderr) { [Console]::WriteLine($result.stderr) }',
    '}\r\n\r\n'
  ].join(' ');
  return [...uploads, execute];
}

function createScriptRunner(send) {
  let pending = null;

  function finish(result) {
    if (!pending) return;
    const { timer, resolve, id } = pending;
    pending = null;
    clearTimeout(timer);
    resolve({ id, ...result });
  }

  function start(script) {
    if (pending) throw new Error('已有脚本在执行，请等待结果');
    if (typeof script !== 'string' || !script.trim() || Buffer.byteLength(script, 'utf8') > SCRIPT_LIMIT) {
      throw new Error(`请提供有效的 PowerShell 脚本，长度不超过 ${SCRIPT_LIMIT} 字节`);
    }
    const id = randomBytes(12).toString('hex');
    const commands = terminalCommands(script, id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish({ status: 'unconfirmed', reason: 'result_timeout' }), RESULT_TIMEOUT);
      pending = { id, timer, resolve, tail: '', chunks: null, length: 0 };
      try {
        for (const command of commands) send({ type: 'exec', stream: 'stdin', payload: command });
      } catch (error) {
        clearTimeout(timer);
        pending = null;
        reject(error);
      }
    });
  }

  function handle(message) {
    if (!pending || message.type !== 'exec' || message.stream !== 'stdout' || typeof message.payload !== 'string') return;
    const lines = (pending.tail + message.payload).split('\n');
    pending.tail = lines.pop().slice(-256);
    for (const raw of lines) {
      const line = stripVTControlCharacters(raw).trim();
      if (line === `YCLJ-${pending.id}:BEGIN`) {
        pending.chunks = [];
        pending.length = 0;
      } else if (pending.chunks && line === `YCLJ-${pending.id}:END`) {
        try {
          const result = JSON.parse(Buffer.from(pending.chunks.join(''), 'base64').toString('utf8'));
          finish(result);
        } catch {
          finish({ status: 'unconfirmed', reason: 'invalid_result' });
        }
        return;
      } else if (pending.chunks && line) {
        pending.length += line.length;
        if (!/^[A-Za-z0-9+/=]+$/.test(line) || pending.length > OUTPUT_LIMIT * 18) {
          finish({ status: 'unconfirmed', reason: 'invalid_result' });
          return;
        }
        pending.chunks.push(line);
      }
    }
  }

  return {
    start,
    handle,
    isRunning: () => Boolean(pending),
    disconnect: () => finish({ status: 'unconfirmed', reason: 'disconnected' })
  };
}

module.exports = { createScriptRunner };
