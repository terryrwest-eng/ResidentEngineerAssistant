; RE Report Assistant — Windows installer
;
; Builds a single Setup.exe that installs the app properly: a folder under
; Program Files, an icon in the Start Menu, and an entry in Add or Remove
; Programs that uninstalls it cleanly.
;
; WHY AN INSTALLER AT ALL: the app was being run straight out of the build
; folder inside OneDrive. That is what made OneDrive mark files read-only and
; block rebuilds, and it meant the Start Menu shortcut pointed at whichever
; copy happened to be built last. Installed, there is one canonical copy in a
; folder Windows manages, and OneDrive never touches it.
;
; Build it with:
;   "C:\Users\Terry\AppData\Local\Programs\Inno Setup 6\ISCC.exe" "RE Report Assistant.iss"

#define AppName        "RE Report Assistant"
#define AppVersion     "3.1.0"
#define AppPublisher   "Terry West"
#define AppExeName     "RE Report Assistant.exe"
#define SourceDir      "..\dist\RE Report Assistant"

[Setup]
; Never change AppId — it is how Windows recognises an upgrade of THIS app
; rather than a second copy of it.
AppId={{8F3C2E94-1B7A-4D65-9E0C-7A2F5B6D41C3}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
; Program Files needs an administrator; Windows asks once when Setup starts.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=.
OutputBaseFilename=RE Report Assistant Setup {#AppVersion}
SetupIconFile=..\app.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; If the app is running, offer to close it rather than failing halfway through.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
; The whole PyInstaller output: the exe plus its _internal folder, which holds
; Python, WebView2 support and the bundled front end.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Open {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; PyInstaller unpacks nothing here, but a crash can leave stray files in the
; app folder; remove the folder itself so an uninstall leaves nothing behind.
; Settings and the saved-report list live in %APPDATA% and are deliberately
; kept, so reinstalling does not lose the work folder setting.
Type: dirifempty; Name: "{app}"
