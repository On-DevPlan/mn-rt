# scripts/install-vigembus.ps1
<#
.SYNOPSIS
    Install or verify the ViGEmBus driver on Windows (idempotent; admin-elevated).

.DESCRIPTION
    ViGEmBus is the kernel-mode driver behind vpad_* (virtual Xbox 360 controller)
    on Windows. input-agent's first vpad_* call attempts this script when the driver
    is missing and reports the result back. The script is also runnable directly:

        pwsh -File scripts/install-vigembus.ps1

    Exit codes:
        0 = driver already installed (or this script installed it successfully + service running)
        1 = install attempted but driver still not detected
        2 = installer failure (download/elevation/user declined UAC)
        3 = admin privileges unavailable

    Idempotent: re-running is safe and a no-op once installed.

.NOTES
    Requires admin (UAC will prompt via -Verb RunAs from a non-elevated shell).
    Tested on Windows 10/11 with PowerShell 5.1+ (ships with Windows).
#>

#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

# ── 路径常量 ────────────────────────────────────────────────────────
$DRIVER_SYS = Join-Path $env:WINDIR 'System32\drivers\ViGEmBus.sys'
$MSVC_REDIST_URL = 'https://github.com/ViGEm/ViGEmBus/releases/latest/download/ViGEmBus_Setup_x64.msi'
$MSI_LOCAL = Join-Path $env:TEMP 'ViGEmBus_Setup_x64.msi'

# ── 1. 已装则直接退出 ─────────────────────────────────────────────
if (Test-Path $DRIVER_SYS) {
    # 顺手启服务；Start-Service 对已运行的 service 是幂等的（no-op）。
    try {
        Start-Service -Name 'ViGEmBus' -ErrorAction Stop
    } catch {
        # service 不存在但 sys 在——多半是持久化被破坏，再走 msiexee 的 REPAIR。
        Write-Host "[install-vigembus] driver sys present but service missing; re-running installer" -ForegroundColor Yellow
        # 落到 install 分支
    }
    if ((Get-Service -Name 'ViGEmBus' -ErrorAction SilentlyContinue).Status -eq 'Running') {
        Write-Host "[install-vigembus] ViGEmBus driver present and running" -ForegroundColor Green
        exit 0
    }
}

# ── 2. 权限校验：非 admin 提前失败 ────────────────────────────────
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    # 用 Write-Host 而非 Write-Error，避开 PS5.1 默认 $ErrorActionPreference='Stop'
    # 直接抛异常绕开 exit 3 的问题——退出码契约明确：3 = admin 不可用。
    Write-Host "[install-vigembus] this script must run as Administrator. Relaunch with -Verb RunAs or from an elevated shell." -ForegroundColor Red
    exit 3
}

# ── 3. 下载安装器 ────────────────────────────────────────────────
Write-Host "[install-vigembus] downloading $MSVC_REDIST_URL" -ForegroundColor Cyan
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $MSVC_REDIST_URL -OutFile $MSI_LOCAL -UseBasicParsing -ErrorAction Stop
} catch {
    Write-Warning "[install-vigembus] download failed: $_"
    Write-Warning "[install-vigembus] manual fallback: download the MSI from the URL above and install with msiexec /i"
    exit 2
}

if (-not (Test-Path $MSI_LOCAL)) {
    Write-Warning "[install-vigembus] MSI not found after download; aborting"
    exit 2
}

# ── 4. 静默安装（/qn），但保留 REBOOT=R 防意外重启 ─────────────
Write-Host "[install-vigembus] running msiexec /i (silent, no-reboot)" -ForegroundColor Cyan
$msiArgs = @(
    '/i', "`"$MSI_LOCAL`""
    '/qn'                          # 完全静默
    'REBOOT=R'                     # 不主动重启
    'MSIFASTINSTALL=1'             # 仅必要动作
)
$proc = Start-Process -FilePath 'msiexec.exe' `
                      -ArgumentList $msiArgs `
                      -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) {
    Write-Warning "[install-vigembus] msiexec exited with code $($proc.ExitCode)"
    exit 2
}

# ── 5. 验证 .sys 落地并启服务 ────────────────────────────────────
Start-Sleep -Seconds 2  # 给内核初始化留点时间
if (-not (Test-Path $DRIVER_SYS)) {
    Write-Warning "[install-vigembus] install reported success but $DRIVER_SYS missing"
    exit 1
}

try {
    Set-Service -Name 'ViGEmBus' -StartupType Automatic -ErrorAction Stop
} catch {
    Write-Warning "[install-vigembus] Set-Service failed (non-fatal): $_"
}
try {
    Start-Service -Name 'ViGEmBus' -ErrorAction Stop
} catch {
    Write-Warning "[install-vigembus] Start-Service failed; reboot may be required: $_"
    exit 1
}

Write-Host "[install-vigembus] ViGEmBus installed and service running" -ForegroundColor Green
exit 0
