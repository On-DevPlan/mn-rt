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
# v1.22.0 是 ViGEmBus 最终版（项目已 EOL），合并架构 exe；老脚本写死的
# ViGEmBus_Setup_x64.msi 在任何 release 里都不存在，下载必 404。
$SETUP_URL = 'https://github.com/ViGEm/ViGEmBus/releases/download/v1.22.0/ViGEmBus_1.22.0_x64_x86_arm64.exe'
$SETUP_LOCAL = Join-Path $env:TEMP 'ViGEmBus_1.22.0_x64_x86_arm64.exe'

# ── 1. 已装则直接退出 ─────────────────────────────────────────────
if (Test-Path $DRIVER_SYS) {
    $svc = Get-Service -Name 'ViGEmBus' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Running') {
        # sys 在、服务没起：试着拉起（Start-Service 需 admin；失败则落安装分支修复）
        try {
            Start-Service -Name 'ViGEmBus' -ErrorAction Stop
        } catch {
            Write-Host "[install-vigembus] driver sys present but service not running; re-running installer" -ForegroundColor Yellow
        }
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

# ── 3. 取安装器：优先 npm 包内自带（零下载，抗网络瞬断），退化为官方源下载 ──
$SETUP_VENDOR = Join-Path $PSScriptRoot 'ViGEmBus_1.22.0_x64_x86_arm64.exe'
$SETUP_SHA256 = '89220a7865076b342892f98865f3499fb7c4cfd673159e89d352c360fd014c6a'

function Get-Installer {
    if (Test-Path $SETUP_VENDOR) {
        $h = (Get-FileHash -Path $SETUP_VENDOR -Algorithm SHA256).Hash.ToLower()
        if ($h -eq $SETUP_SHA256) {
            Write-Host "[install-vigembus] using bundled installer: $SETUP_VENDOR" -ForegroundColor Cyan
            return $SETUP_VENDOR
        }
        Write-Warning "[install-vigembus] bundled installer hash mismatch; falling back to download"
    }
    for ($i = 1; $i -le 3; $i++) {
        Write-Host "[install-vigembus] downloading $SETUP_URL (attempt $i/3)" -ForegroundColor Cyan
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $SETUP_URL -OutFile $SETUP_LOCAL -UseBasicParsing -ErrorAction Stop
            return $SETUP_LOCAL
        } catch {
            Write-Warning "[install-vigembus] download attempt ${i} failed: $_"
            Start-Sleep -Seconds 2
        }
    }
    Write-Warning "[install-vigembus] manual fallback: download the exe from the URL above and run it with /quiet /norestart"
    return $null
}

$setup = Get-Installer
if (-not $setup) { exit 2 }

# ── 4. 静默安装（Burn 引导器标准开关），不主动重启 ─────────────
Write-Host "[install-vigembus] running installer (quiet, no-reboot)" -ForegroundColor Cyan
$proc = Start-Process -FilePath $setup `
                      -ArgumentList '/quiet', '/norestart' `
                      -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) {
    Write-Warning "[install-vigembus] installer exited with code $($proc.ExitCode)"
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
