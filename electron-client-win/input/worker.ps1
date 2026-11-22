$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -Path $env:YCLJ_INPUT_ASSEMBLY
$driver = New-Object WindowsInput.InputSimulator
$keys = @{}
$buttons = @{}
$wheelX = 0
$wheelY = 0

function Release-Keys {
    foreach ($key in @($keys.Values | Select-Object -Unique)) {
        try { $null = $driver.Keyboard.KeyUp($key) } catch {}
    }
    $keys.Clear()
}

function Set-Button($id, $down) {
    if ($id -eq 0) {
        if ($down) { $null = $driver.Mouse.LeftButtonDown() } else { $null = $driver.Mouse.LeftButtonUp() }
    } elseif ($id -eq 2) {
        if ($down) { $null = $driver.Mouse.RightButtonDown() } else { $null = $driver.Mouse.RightButtonUp() }
    }
}

try {
    [Console]::WriteLine('ok')
    while ($null -ne ($line = [Console]::ReadLine())) {
        $event = ConvertFrom-Json -InputObject $line
        if ($event.action -in @('move', 'button', 'wheel')) {
            $null = $driver.Mouse.MoveMouseTo([Math]::Round($event.x * 65535), [Math]::Round($event.y * 65535))
        }
        switch ($event.action) {
            'button' {
                $id = [int]$event.button
                if ($event.down) {
                    $buttons[$id] = $true
                    Set-Button $id $true
                } elseif ($buttons.ContainsKey($id)) {
                    Set-Button $id $false
                    $buttons.Remove($id)
                }
            }
            'wheel' {
                $wheelX += $event.dx
                $wheelY += $event.dy
                $horizontal = [Math]::Truncate($wheelX / 120)
                $vertical = [Math]::Truncate($wheelY / 120)
                if ($horizontal) { $null = $driver.Mouse.HorizontalScroll([int]$horizontal) }
                if ($vertical) { $null = $driver.Mouse.VerticalScroll([int]$vertical) }
                $wheelX -= $horizontal * 120
                $wheelY -= $vertical * 120
            }
            'key' {
                $key = [WindowsInput.Native.VirtualKeyCode]$event.key
                if ($event.down) {
                    $keys[$event.code] = $key
                    $null = $driver.Keyboard.KeyDown($key)
                } elseif ($keys.ContainsKey($event.code)) {
                    $keys.Remove($event.code)
                    if ($key -notin $keys.Values) { $null = $driver.Keyboard.KeyUp($key) }
                }
            }
            'text' {
                Release-Keys
                $null = $driver.Keyboard.TextEntry([string]$event.text)
            }
        }
        [Console]::WriteLine('ok')
    }
} finally {
    Release-Keys
    foreach ($id in $buttons.Keys) { try { Set-Button $id $false } catch {} }
}
