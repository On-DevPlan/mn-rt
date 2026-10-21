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

# 进度通道：本脚本以管理员身份在**独立控制台**里运行（-Verb RunAs 必然如此），
# 它的 stdout 到不了 nx-rt 所在的终端。所以进度写进一个文件，由 nx-rt 主进程
# （CLI 的 install-driver 或 serve 的后台监听）读取并渲染成进度条。
# 行格式：`<百分比>|<阶段说明>`，便于调用方直接解析。
param(
    [string]$ProgressFile = (Join-Path $env:TEMP 'nx-rt-vigembus-progress.log')
)

$ErrorActionPreference = 'Stop'

function Write-Stage([int]$Pct, [string]$Text) {
    try {
        # 用 .NET API 而非 Add-Content -Encoding utf8：PowerShell 5.1 的 utf8
        # 会写 BOM，调用方按行解析时首行会带上 ﻿ → 百分比解析成 NaN，
        # 进度条直接哑掉。显式用「无 BOM 的 UTF8Encoding」。
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($ProgressFile, "$Pct|$Text`n", $enc)
    } catch {
        # 进度写不进去不影响安装本身
    }
    Write-Host "[install-vigembus] $Text" -ForegroundColor Cyan
}

# 每次运行清空进度文件：调用方只看本次的进度，残留旧行会误导。
try {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ProgressFile, '', $enc)
} catch { }

# ── 自我隐藏控制台窗口 ──────────────────────────────────────────────
# 提权必然新开控制台（Windows 不允许提权既有进程），调用方即便传了
# -WindowStyle Hidden 也可能有别的启动路径漏掉。脚本自己把窗口藏起来是最
# 可靠的一道：进程照常运行，只是没有可见窗口，进度由调用方从进度文件读取
# 后渲染在 nx-rt 自己的窗口里。
# 失败不影响安装（Add-Type 编译失败、无控制台等场景直接跳过）。
try {
    Add-Type -Namespace NxRt -Name Win -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@ -ErrorAction Stop
    $h = [NxRt.Win]::GetConsoleWindow()
    if ($h -ne [IntPtr]::Zero) {
        [void][NxRt.Win]::ShowWindow($h, 0)   # 0 = SW_HIDE
    }
} catch {
    # 隐藏失败不是错误：顶多控制台窗口可见，功能不受影响
}

# 留痕：提权子进程会新开控制台，调用方（Node / rust 引擎）拿不到 stdout，
# 失败原因会彻底黑盒。把本次执行的输出同时落到日志文件，供事后排查。
$TranscriptPath = Join-Path $env:TEMP 'mn-rt-vigembus-install.log'
try {
  Start-Transcript -Path $TranscriptPath -Append -Force | Out-Null
} catch {
  # 转录失败不影响安装主流程
}

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
        Write-Stage 100 '驱动已安装且服务运行中，无需操作'
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
    Write-Stage 100 '失败：本脚本需要管理员权限（请用 -Verb RunAs 重新启动）'
    Write-Host "[install-vigembus] this script must run as Administrator. Relaunch with -Verb RunAs or from an elevated shell." -ForegroundColor Red
    exit 3
}

# ── 3. 取安装器：优先 npm 包内自带（零下载，抗网络瞬断），退化为官方源下载 ──
#
# ⚠️ 不要用 `Join-Path $PSScriptRoot ...`：rust 引擎用
# std::env::current_exe() 拼脚本路径，Windows 上带 `\\?\` verbatim 前缀；
# Join-Path 解析不了这种路径（报「参数 drive 的值为空」），脚本会在这里
# 直接终止失败、退出码 1，而调用方（提权子进程）拿不到输出、只看到
# "exited with code 1"。字符串拼接对 verbatim 路径是安全的。
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
    try { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path } catch { $ScriptDir = $null }
}
$SETUP_VENDOR = if ($ScriptDir) { "$ScriptDir\ViGEmBus_1.22.0_x64_x86_arm64.exe" } else { $null }
$SETUP_SHA256 = '89220a7865076b342892f98865f3499fb7c4cfd673159e89d352c360fd014c6a'

function Get-Installer {
    if ($SETUP_VENDOR -and (Test-Path -LiteralPath $SETUP_VENDOR)) {
        $h = (Get-FileHash -LiteralPath $SETUP_VENDOR -Algorithm SHA256).Hash.ToLower()
        if ($h -eq $SETUP_SHA256) {
            Write-Stage 30 '使用包内自带安装器（无需下载）'
            return $SETUP_VENDOR
        }
        Write-Warning "[install-vigembus] bundled installer hash mismatch; falling back to download"
    }
    for ($i = 1; $i -le 3; $i++) {
        Write-Stage 25 "包内安装器不可用，正在下载（第 $i/3 次）…"
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

Write-Stage 15 '正在定位安装器…'
$setup = Get-Installer
if (-not $setup) {
    Write-Stage 100 '失败：既无包内安装器也下载不到，请手动安装 ViGEmBus'
    exit 2
}

# ── 4. 静默安装（Burn 引导器标准开关），不主动重启 ─────────────
Write-Stage 45 '正在静默安装驱动（通常 10-60 秒）…'
$proc = Start-Process -FilePath $setup `
                      -ArgumentList '/quiet', '/norestart' `
                      -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) {
    Write-Stage 100 "失败：安装器退出码 $($proc.ExitCode)"
    Write-Warning "[install-vigembus] installer exited with code $($proc.ExitCode)"
    exit 2
}

# ── 5. 验证 .sys 落地并启服务 ────────────────────────────────────
Write-Stage 75 '安装器已退出，正在校验驱动文件…'
Start-Sleep -Seconds 2  # 给内核初始化留点时间
if (-not (Test-Path $DRIVER_SYS)) {
    Write-Stage 100 "失败：安装器报成功但 $DRIVER_SYS 不存在"
    Write-Warning "[install-vigembus] install reported success but $DRIVER_SYS missing"
    exit 1
}

try {
    Set-Service -Name 'ViGEmBus' -StartupType Automatic -ErrorAction Stop
} catch {
    Write-Warning "[install-vigembus] Set-Service failed (non-fatal): $_"
}
Write-Stage 88 '正在启动 ViGEmBus 服务…'
try {
    Start-Service -Name 'ViGEmBus' -ErrorAction Stop
} catch {
    Write-Stage 100 "失败：驱动已装但服务启动不了（可能要重启）"
    Write-Warning "[install-vigembus] Start-Service failed; reboot may be required: $_"
    exit 1
}

Write-Stage 100 '安装完成，ViGEmBus 服务运行中'
exit 0
