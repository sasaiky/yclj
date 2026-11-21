!if "${APP_ID}" == "com.yclj.client.win"
  !ifndef BUILD_UNINSTALLER
    !define /redef APP_FILENAME "kkssh clent"
  !endif
!endif

!macro customInit
  ; Migrate old default locations while retaining user-selected locations.
  ${If} $INSTDIR == "$LOCALAPPDATA\Programs\yclj-stack"
  !if "${APP_ID}" == "com.yclj.client.win"
    ${OrIf} $INSTDIR == "$LOCALAPPDATA\Programs\yclj-client-win"
  !endif
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  ${EndIf}

  ; The host relay is another process with the same executable name. Stop all
  ; copies before electron-builder removes the old version.
  DetailPrint "Stopping running ${PRODUCT_NAME} processes..."
  nsExec::ExecToLog `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 1000
!macroend
