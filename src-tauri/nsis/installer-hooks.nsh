!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\AppUserModelId\app.ytmusic.desktop" "DisplayName" "YouTube Music"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\app.ytmusic.desktop" "IconUri" "$INSTDIR\yt-music-tauri.exe"
  WriteRegDWORD HKCU "Software\Classes\AppUserModelId\app.ytmusic.desktop" "ShowInSettings" 1
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\app.ytmusic.desktop"
!macroend
