param(
  [string]$ExecutablePath = (Join-Path $PSScriptRoot '..\release-host-client\win-unpacked\远程帮助主机端.exe')
)

$ErrorActionPreference = 'Stop'
$manifestPath = if ($env:YCLJ_HOST_CONTROL_FILE) {
  $env:YCLJ_HOST_CONTROL_FILE
} else {
  Join-Path $env:APPDATA 'yclj-host-win\agent-control.json'
}
function Get-ControlToken {
  if ($env:ADMIN_TOKEN -and $env:ADMIN_TOKEN.Length -ge 32) { return $env:ADMIN_TOKEN }
  if ($env:YCLJ_ADMIN_TOKEN -and $env:YCLJ_ADMIN_TOKEN.Length -ge 32) { return $env:YCLJ_ADMIN_TOKEN }
  $tokenPath = if ($env:YCLJ_OPERATOR_TOKEN_FILE) { $env:YCLJ_OPERATOR_TOKEN_FILE } else {
    Join-Path $env:APPDATA 'yclj-host-win\operator-token'
  }
  return (Get-Content -LiteralPath $tokenPath -Raw).Trim()
}
if (Test-Path -LiteralPath $manifestPath) {
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $headers = @{ Authorization = "Bearer $(Get-ControlToken)" }
    $url = "http://127.0.0.1:$($manifest.port)"
    $state = Invoke-RestMethod -Uri "$url/status" -Headers $headers -TimeoutSec 2
    if ($state.status -ne 'running' -and $state.status -ne 'starting') {
      Invoke-RestMethod -Uri "$url/start" -Headers $headers -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 2 | Out-Null
    }
    for ($readyAttempt = 0; $readyAttempt -lt 40; $readyAttempt++) {
      $state = Invoke-RestMethod -Uri "$url/status" -Headers $headers -TimeoutSec 2
      if ($state.status -eq 'running') {
        Write-Output "主机服务已在后台运行，进程号 $($manifest.pid)"
        return
      }
      if ($state.status -eq 'error') { throw "主机服务未能启动：$($state.message)" }
      Start-Sleep -Milliseconds 250
    }
    throw '主机服务启动超时'
  } catch {
    if (Get-Process -Id $manifest.pid -ErrorAction SilentlyContinue) { throw }
  }
}

$resolvedExe = (Resolve-Path -LiteralPath $ExecutablePath).Path
$hostProcess = Start-Process -FilePath $resolvedExe -ArgumentList '--background' -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.pid -eq $hostProcess.Id) {
      $token = Get-ControlToken
      $headers = @{ Authorization = "Bearer $token" }
      $url = "http://127.0.0.1:$($manifest.port)"
      for ($readyAttempt = 0; $readyAttempt -lt 40; $readyAttempt++) {
        $state = Invoke-RestMethod -Uri "$url/status" -Headers $headers
        if ($state.status -eq 'running') {
          Write-Output "主机服务已在后台启动，进程号 $($hostProcess.Id)"
          return
        }
        if ($state.status -eq 'error') { break }
        Start-Sleep -Milliseconds 250
      }
      Invoke-RestMethod -Uri "$url/shutdown" -Headers $headers -Method Post -ContentType 'application/json' -Body '{}' | Out-Null
      throw "主机服务未能启动：$($state.message)"
    }
  }
  if ($hostProcess.HasExited) { throw '主机服务启动失败' }
  Start-Sleep -Milliseconds 250
}
throw '主机服务启动超时'
