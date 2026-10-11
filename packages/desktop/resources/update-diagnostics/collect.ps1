# Read-only snapshot, invoked only after the user chooses Export update diagnostics.
# No process termination, file writes/deletes, registry mutation, or policy changes.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$install = [Environment]::GetEnvironmentVariable('PERCHO_UPDATE_INSTALL_DIR')
$prefix = $install.TrimEnd('\') + '\'
$errors = @()
$processes = @()
$registrations = @()
$longest = @()
$sampledFiles = 0
try {
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or
        $_.Name -eq 'Percho.exe' -or $_.Name -eq 'old-uninstaller.exe' -or $_.Name -eq 'percho-windows-x64.exe'
    } | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath)
} catch { $errors += 'process-snapshot: ' + $_.Exception.Message }
foreach ($root in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)) {
    try {
        if (Test-Path -LiteralPath $root) {
            $registrations += @(Get-ChildItem -LiteralPath $root | Get-ItemProperty | Where-Object {
                $_.DisplayName -eq 'Percho'
            } | Select-Object @{Name='RegistryRoot';Expression={$root}}, DisplayName, DisplayVersion, InstallLocation, UninstallString)
        }
    } catch { $errors += 'registration-snapshot: ' + $_.Exception.Message }
}
try {
    # A bounded sample, not proof that every path is short or no file is locked.
    $files = @(Get-ChildItem -LiteralPath $install -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 10000)
    $sampledFiles = $files.Count
    $longest = @($files | Sort-Object { $_.FullName.Length } -Descending | Select-Object -First 20 |
        Select-Object FullName, @{Name='PathLength';Expression={$_.FullName.Length}}, Length)
} catch { $errors += 'path-snapshot: ' + $_.Exception.Message }
[ordered]@{
    capturedAt = [DateTime]::UtcNow.ToString('o')
    tickCount = [Environment]::TickCount
    notice = 'Current read-only snapshot, not a capture of the earlier installer failure. Command lines and process environments are not collected.'
    processes = $processes
    uninstallRegistrations = $registrations
    pathSample = @{ sampledFiles = $sampledFiles; limit = 10000; longest = $longest }
    errors = $errors
} | ConvertTo-Json -Depth 6
