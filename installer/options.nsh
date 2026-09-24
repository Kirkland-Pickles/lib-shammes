!include nsDialogs.nsh
!include UAC.nsh
!define MUI_ABORTWARNING
!define MUI_UNABORTWARNING

!ifndef BUILD_UNINSTALLER
  Var desktopShortcut
  Var desktopCheckbox
  Var desktopScope

  !macro _skipDesktopShortcut _a _b _t _f
    StrCmp $desktopShortcut "0" `${_t}` 0
    !insertmacro _isNoDesktopShortcut `${_a}` `${_b}` `${_t}` `${_f}`
  !macroend
  !undef isNoDesktopShortcut
  !define isNoDesktopShortcut `"" skipDesktopShortcut ""`

  !macro customHeader
  Function readDesktopChoice
    ${If} $desktopScope == $installMode
      Return
    ${EndIf}
    StrCpy $desktopScope $installMode
    StrCpy $desktopShortcut ${BST_UNCHECKED}
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
      !insertmacro setLinkVars
      ${If} ${FileExists} "$oldDesktopLink"
        StrCpy $desktopShortcut ${BST_CHECKED}
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function desktopPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    Call readDesktopChoice
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose whether to add a desktop shortcut."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateCheckbox} 0 0 100% 12u "Create a desktop shortcut"
    Pop $desktopCheckbox
    ${NSD_SetState} $desktopCheckbox $desktopShortcut
    nsDialogs::Show
  FunctionEnd

  Function desktopPageLeave
    ${NSD_GetState} $desktopCheckbox $desktopShortcut
  FunctionEnd
  !macroend

  !macro customInit
    Call readDesktopChoice
  !macroend

  !macro customPageAfterChangeDir
    Page custom desktopPage desktopPageLeave
  !macroend
!else
  !define removeDefaultUninstallWelcomePage
  !define MUI_COMPONENTSPAGE_TEXT_TOP "Undo Steam changes uses the account selected in Settings. Games are kept. Deleting settings also deletes the undo history."
  !define MUI_PAGE_CUSTOMFUNCTION_PRE un.optionsPre
  !macro customHeader
  Function un.optionsPre
    ${If} ${UAC_IsInnerInstance}
      Abort
    ${EndIf}
  FunctionEnd

  Function un.cleanup
    ClearErrors
    ExecWait '"$0" --uninstall-cleanup $2' $1
    ${If} ${Errors}
      StrCpy $1 1
    ${EndIf}
  FunctionEnd
  !macroend

  !macro customUnInstall
    ${IfNot} ${isUpdated}
    ${AndIfNot} ${Silent}
      Call un.runCleanup
    ${EndIf}
  !macroend

  !macro customUnInstallSection
    Section /o "un.Undo Steam changes" undoSteam
    SectionEnd
    Section /o "un.Delete settings, saved matches, and undo history" deleteData
    SectionEnd

    Function un.runCleanup
      StrCpy $2 ""
      !insertmacro UAC_AsUser_GetSection Flags ${undoSteam} $3
      IntOp $3 $3 & ${SF_SELECTED}
      ${If} $3 != 0
        StrCpy $2 "--purge-steam"
      ${EndIf}
      !insertmacro UAC_AsUser_GetSection Flags ${deleteData} $3
      IntOp $3 $3 & ${SF_SELECTED}
      ${If} $3 != 0
        StrCpy $2 "$2 --delete-app-data"
      ${EndIf}
      ${If} $2 == ""
        Return
      ${EndIf}
      StrCpy $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $1 1
      !insertmacro UAC_AsUser_Call Function un.cleanup ${UAC_SYNCREGISTERS}
      ${If} $1 != 0
        SetErrorLevel 1
        Abort "Uninstall cancelled. Lib Shammes has not been removed."
      ${EndIf}
    FunctionEnd
  !macroend
!endif
