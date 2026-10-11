# Dedicated update trace, separate from install directory/ephemeral PLUGINSDIR.
# Hooks below preserve electron-builder 26.15.3 handleUninstallResult semantics.
# No process-check bypass, forced overwrite, registry deletion or customRemoveFiles.
Var /GLOBAL perchoTraceFile
Var /GLOBAL perchoTracePath
Var /GLOBAL perchoTraceRoot
Var /GLOBAL perchoTracePid
Var /GLOBAL perchoTraceTick
Var /GLOBAL perchoTraceLength
Var /GLOBAL perchoTraceErrors
Var /GLOBAL perchoTraceExtra
Var /GLOBAL perchoTraceUpdated
Var /GLOBAL perchoTraceForceRun
Var /GLOBAL perchoUninstallExit
Var /GLOBAL perchoUninstallLaunchFailed
Var /GLOBAL perchoOldDirectory
Var /GLOBAL perchoOldUninstall

!macro PerchoUpdateTrace STAGE
  # Capture before any file command can change the NSIS error flag.
  IfErrors percho_trace_error_${STAGE} percho_trace_ok_${STAGE}
  percho_trace_error_${STAGE}:
    StrCpy $perchoTraceErrors 1
    Goto percho_trace_start_${STAGE}
  percho_trace_ok_${STAGE}:
    StrCpy $perchoTraceErrors 0
  percho_trace_start_${STAGE}:
    # Generated flag helpers use R9. Do not leak their scratch register to caller.
    Push $R9
    StrCpy $perchoTraceUpdated "unknown"
    StrCpy $perchoTraceForceRun "unknown"
    !ifdef isUpdated
      StrCpy $perchoTraceUpdated 0
      ${if} ${isUpdated}
        StrCpy $perchoTraceUpdated 1
      ${endIf}
    !endif
    !ifdef isForceRun
      StrCpy $perchoTraceForceRun 0
      ${if} ${isForceRun}
        StrCpy $perchoTraceForceRun 1
      ${endIf}
    !endif
    Pop $R9
    ReadEnvStr $perchoTraceRoot "LOCALAPPDATA"
    StrCmp $perchoTraceRoot "" percho_trace_done_${STAGE}
    StrCpy $perchoTracePath "$perchoTraceRoot\Percho\update-diagnostics\nsis.log"
    CreateDirectory "$perchoTraceRoot\Percho\update-diagnostics"
    ClearErrors
    FileOpen $perchoTraceFile "$perchoTracePath" a
    IfErrors percho_trace_done_${STAGE}
    FileSeek $perchoTraceFile 0 END $perchoTraceLength
    StrCmp $perchoTraceLength 0 0 +2
      FileWriteUTF16LE /BOM $perchoTraceFile ""
    System::Call 'kernel32::GetCurrentProcessId() i .s'
    Pop $perchoTracePid
    System::Call 'kernel32::GetTickCount() i .s'
    Pop $perchoTraceTick
    FileWriteUTF16LE $perchoTraceFile "stage=${STAGE}|pid=$perchoTracePid|tick=$perchoTraceTick|built-version=${VERSION}|mode=$installMode|updated=$perchoTraceUpdated|force-run=$perchoTraceForceRun|install-dir=$INSTDIR|$perchoTraceExtra$\r$\n"
    FileClose $perchoTraceFile
  percho_trace_done_${STAGE}:
    StrCmp $perchoTraceErrors 1 0 percho_trace_clear_${STAGE}
      SetErrors
      Goto percho_trace_end_${STAGE}
    percho_trace_clear_${STAGE}:
      ClearErrors
    percho_trace_end_${STAGE}:
!macroend

!macro customInit
  # Assisted installer users can still change directory/mode after this initial observation.
  StrCpy $perchoTraceExtra "initial-directory-and-mode=not-final"
  !insertmacro PerchoUpdateTrace installer-init
!macroend

!macro customUnInit
  StrCpy $perchoTraceExtra "old-file-failures-not-observable-in-this-hook"
  !insertmacro PerchoUpdateTrace uninstaller-init
!macroend

!macro customInstall
  StrCpy $perchoTraceExtra "new-files-installed"
  !insertmacro PerchoUpdateTrace installer-files-installed
!macroend

!macro PerchoHandleUninstallResult ROOT
  # A hook REPLACES the stock handler (stock immediately returns after the macro).
  # Save flag and exit code before logging, then retain its launch-error/nonzero/success branches.
  IfErrors percho_uninstall_launch_error_${ROOT} percho_uninstall_launched_${ROOT}
  percho_uninstall_launch_error_${ROOT}:
    StrCpy $perchoUninstallLaunchFailed 1
    Goto percho_uninstall_capture_${ROOT}
  percho_uninstall_launched_${ROOT}:
    StrCpy $perchoUninstallLaunchFailed 0
  percho_uninstall_capture_${ROOT}:
    StrCpy $perchoUninstallExit $R0
    # installUtil declares its own old-path vars AFTER this hook's expansion point.
    # Query registry into our own already-declared vars; an absent entry is not an install failure.
    ReadRegStr $perchoOldDirectory ${ROOT} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ReadRegStr $perchoOldUninstall ${ROOT} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    StrCpy $perchoTraceExtra "registry-pass=${ROOT}|launch-failed=$perchoUninstallLaunchFailed|exit-code=$perchoUninstallExit|registered-old-directory=$perchoOldDirectory|registered-uninstall-command=$perchoOldUninstall|staged-old-uninstaller=$PLUGINSDIR\old-uninstaller.exe"
    !insertmacro PerchoUpdateTrace uninstall-result-${ROOT}
    StrCpy $R0 $perchoUninstallExit
    # Restore original flag, then execute the exact stock IfErrors/Return semantics.
    StrCmp $perchoUninstallLaunchFailed 1 0 percho_uninstall_clear_${ROOT}
      SetErrors
      Goto percho_uninstall_decide_${ROOT}
    percho_uninstall_clear_${ROOT}:
      ClearErrors
    percho_uninstall_decide_${ROOT}:
      IfErrors 0 +3
        DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
        Return
      ${if} $R0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $perchoUninstallExit$\r$\nDiagnostic log (if writable): $perchoTracePath"
        DetailPrint "Uninstall was not successful. Uninstaller error code: $perchoUninstallExit."
        SetErrorLevel 2
        Quit
      ${endIf}
!macroend

!macro customUnInstallCheck
  !insertmacro PerchoHandleUninstallResult SHELL_CONTEXT
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro PerchoHandleUninstallResult HKEY_CURRENT_USER
!macroend
