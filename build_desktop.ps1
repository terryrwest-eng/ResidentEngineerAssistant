# build_desktop.ps1 — Build the RE Report Assistant native Windows app
#
# This script:
#   1. Creates a Python venv in desktop/
#   2. Installs pywebview + httpx
#   3. Runs PyInstaller to create the .exe
#
# Output: desktop/dist/RE Report Assistant/RE Report Assistant.exe

Write-Host "=== Building RE Report Assistant Desktop App ===" -ForegroundColor Cyan

# --- Step 1: Set up virtual environment ---
Write-Host "`n[1/3] Setting up Python virtual environment..." -ForegroundColor Yellow
Set-Location desktop

if (-not (Test-Path "venv")) {
    python -m venv venv
}
. .\venv\Scripts\Activate.ps1

# --- Step 2: Install dependencies ---
Write-Host "`n[2/3] Installing dependencies..." -ForegroundColor Yellow
pip install -r requirements.txt
pip install pyinstaller

# --- Step 3: Bundle with PyInstaller ---
Write-Host "`n[3/3] Bundling with PyInstaller..." -ForegroundColor Yellow

# Clear the previous output FIRST.
#
# WHY: PyInstaller deletes dist\ itself before writing, and when anything holds
# a handle in there it dies with "PermissionError: [WinError 5] Access is
# denied" partway through cleanup - after a full successful build. It reads as
# a build failure and is not one. Windows Defender scanning recently written or
# recently copied files is enough to cause it.
#
# Worse, a stuck dist\ folder travels: copying the project somewhere else to
# escape the problem brings the obstruction along and the new location fails
# the same way.
foreach ($stale in @("dist", "build")) {
    if (Test-Path $stale) {
        Get-ChildItem $stale -Recurse -Force -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Attributes = 'Normal' }
        Remove-Item $stale -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if (Test-Path "dist") {
    Write-Host "Could not clear desktop\dist - close the app if it is running, then re-run." -ForegroundColor Red
    Set-Location ..
    exit 1
}

# Call the venv's PyInstaller by full path rather than relying on the name.
# Activate.ps1 does not always win against a venv already on PATH, and this
# build was found running the copy from a DIFFERENT checkout of the project.
$pyInstaller = Join-Path $PWD "venv\Scripts\pyinstaller.exe"
if (-not (Test-Path $pyInstaller)) {
    Write-Host "pyinstaller.exe missing from desktop\venv - the pip install above failed." -ForegroundColor Red
    Set-Location ..
    exit 1
}

& $pyInstaller --noconfirm --name "RE Report Assistant" --windowed --hidden-import=pythonnet --hidden-import=clr_loader --collect-all webview app.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nBUILD FAILED (pyinstaller exit $LASTEXITCODE)" -ForegroundColor Red
    Set-Location ..
    exit $LASTEXITCODE
}

Set-Location ..

Write-Host "`n=== BUILD COMPLETE ===" -ForegroundColor Green
Write-Host "Executable: desktop\dist\RE Report Assistant\RE Report Assistant.exe"

Write-Host "`n[4/4] Creating Start Menu Shortcut..." -ForegroundColor Yellow
$wshShell = New-Object -ComObject WScript.Shell
$startMenu = [Environment]::GetFolderPath("Programs")
$shortcut = $wshShell.CreateShortcut("$startMenu\RE Report Assistant.lnk")
$shortcut.TargetPath = "$PWD\desktop\dist\RE Report Assistant\RE Report Assistant.exe"
$shortcut.WorkingDirectory = "$PWD\desktop\dist\RE Report Assistant"
$shortcut.IconLocation = "$PWD\desktop\dist\RE Report Assistant\RE Report Assistant.exe,0"
$shortcut.Save()

Write-Host "Shortcut created! You can now press the Windows key and type 'RE Report Assistant'." -ForegroundColor Green
