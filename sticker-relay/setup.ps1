# One-time setup of the sticker printer laptop. Run it as administrator:
#   right-click setup.ps1 > Run with PowerShell (accept the admin prompt), or
#   powershell -ExecutionPolicy Bypass -File setup.ps1   (from an admin window)
#
# It is safe to run again; each step skips what is already done.
#   1. Installs Node.js LTS (winget) if it is missing.
#   2. Adds Windows' built-in "Generic / Text Only" printer driver.
#   3. Makes the "XPrinter Label" print queue on the sticker printer's USB port.
#   4. Starts the helper at every login (shortcut in your Startup folder).
#   5. Starts the helper now.

$ErrorActionPreference = 'Stop'
$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$queueName = 'XPrinter Label'
$driver    = 'Generic / Text Only'

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Please run this as administrator (it adds a printer and a driver).' -ForegroundColor Yellow
  exit 1
}

# 1. Node.js
Step 'Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Node.js LTS with winget...'
  winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js did not install. Install it from nodejs.org and run this again.' }
}
Write-Host "Node $(node --version)"

# 2. Driver
Step 'Printer driver'
if (-not (Get-PrinterDriver -Name $driver -ErrorAction SilentlyContinue)) {
  Add-PrinterDriver -Name $driver
}
Write-Host "$driver ready"

# 3. Print queue on the sticker printer's USB port
Step 'Sticker print queue'
$port = Get-PrinterPort | Where-Object { $_.Name -like 'USB*' -and $_.Description -match 'xprinter|xp-?3[0-9]0' } | Select-Object -First 1
$queue = Get-Printer -Name $queueName -ErrorAction SilentlyContinue
if (-not $port) {
  if ($queue) { Write-Host "Queue '$queueName' already exists on $($queue.PortName)." }
  else { throw 'No Xprinter USB port found. Plug the sticker printer in, switch it on, wait 10 seconds and run this again.' }
} elseif (-not $queue) {
  Add-Printer -Name $queueName -DriverName $driver -PortName $port.Name
  Write-Host "Created '$queueName' on $($port.Name) ($($port.Description))"
} elseif ($queue.PortName -ne $port.Name) {
  Set-Printer -Name $queueName -PortName $port.Name
  Write-Host "Moved '$queueName' to $($port.Name)"
} else {
  Write-Host "'$queueName' already on $($port.Name)"
}

# 4. Start at login
Step 'Start at login'
$startup  = [Environment]::GetFolderPath('Startup')
$lnkPath  = Join-Path $startup 'Aadinath Sticker Helper.lnk'
$shell    = New-Object -ComObject WScript.Shell
$lnk      = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath       = 'wscript.exe'
$lnk.Arguments        = '"' + (Join-Path $here 'start-helper.vbs') + '"'
$lnk.WorkingDirectory = $here
$lnk.Description      = 'Sticker printer helper for the Labels page'
$lnk.Save()
Write-Host "Shortcut: $lnkPath"

# 5. (Re)start the helper now
Step 'Starting the helper'
Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'run-helper\.cmd' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'server\.js') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# Through Explorer so the helper runs as you, not as administrator (same as at login).
Start-Process explorer.exe -ArgumentList ('"' + (Join-Path $here 'start-helper.vbs') + '"')
Start-Sleep -Seconds 6
$log = Join-Path $here 'helper.log'
if (Test-Path $log) { Get-Content $log | Select-Object -Last 8 }

Write-Host "`nDone. The helper now starts by itself whenever you log in." -ForegroundColor Green
Write-Host 'If this is the first run, register the "Helper id" above once in Supabase (see supabase/18_print_queue.sql).'
