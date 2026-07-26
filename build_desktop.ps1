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
pyinstaller --noconfirm --name "RE Report Assistant" --windowed --hidden-import=pythonnet --hidden-import=clr_loader --collect-all webview app.py

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
