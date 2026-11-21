; Adds the `omega` command for the current user: a small omega.cmd in <install folder>\bin, and that
; folder on the *user* PATH. No admin rights. The PATH is edited through .NET because NSIS strings
; are limited in length (a truncated write would destroy the PATH) and to keep %VARIABLES% as they
; are. The folder is passed in an environment variable so a path can't break the command line.

!include LogicLib.nsh

!macro OMEGA_EDIT_PATH SCRIPT
  Push $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "OMEGA_BIN", t "$INSTDIR\bin")i'
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$v=$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$l=@($$v -split ';' | Where-Object { $$_ -ne '' -and $$_ -ne $$env:OMEGA_BIN }); ${SCRIPT} $$k.SetValue('Path',($$l -join ';'),[Microsoft.Win32.RegistryValueKind]::ExpandString)"`
  Pop $0 ; exit code of PowerShell
  Pop $0
  ; Tell running programs (new terminals) that the environment changed.
  ; HWND_BROADCAST, WM_SETTINGCHANGE
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=2000
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  CreateDirectory "$INSTDIR\bin"
  FileOpen $0 "$INSTDIR\bin\omega.cmd" w
  FileWrite $0 "@echo off$\r$\nrem omega-launcher$\r$\n$\"$INSTDIR\${MAINBINARYNAME}.exe$\" %*$\r$\nexit /b %errorlevel%$\r$\n"
  FileClose $0
  Pop $0
  !insertmacro OMEGA_EDIT_PATH "$$l += $$env:OMEGA_BIN;"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; An update reinstalls over the old version and keeps the command.
  ${If} $UpdateMode <> 1
    !insertmacro OMEGA_EDIT_PATH ""
    Delete "$INSTDIR\bin\omega.cmd"
    RMDir "$INSTDIR\bin"
  ${EndIf}
!macroend
