; Markon NSIS installer hooks.
;
; Tauri's NSIS template (tauri-bundler 2.x) invokes macros named
; NSIS_HOOK_{PRE,POST}INSTALL / NSIS_HOOK_{PRE,POST}UNINSTALL — NOT the
; electron-builder-style customInstall / customUninstall. Using the wrong
; names makes Tauri silently include this file and then never call the
; macros, which is why earlier 0.9.x installs had no right-click menu
; entries despite this file existing.

!macro NSIS_HOOK_POSTINSTALL
  ; ── .md / .markdown context menu ────────────────────────────────────────
  WriteRegStr HKCU "Software\Classes\.md\shell\open_with_markon" \
    "" "用 Markon 打开"
  WriteRegStr HKCU "Software\Classes\.md\shell\open_with_markon" \
    "Icon" "$INSTDIR\markon-gui.exe,0"
  WriteRegStr HKCU "Software\Classes\.md\shell\open_with_markon\command" \
    "" '"$INSTDIR\markon-gui.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\.markdown\shell\open_with_markon" \
    "" "用 Markon 打开"
  WriteRegStr HKCU "Software\Classes\.markdown\shell\open_with_markon" \
    "Icon" "$INSTDIR\markon-gui.exe,0"
  WriteRegStr HKCU "Software\Classes\.markdown\shell\open_with_markon\command" \
    "" '"$INSTDIR\markon-gui.exe" "%1"'

  ; ── Directory right-click (folder icon) ──────────────────────────────────
  WriteRegStr HKCU "Software\Classes\Directory\shell\open_with_markon" \
    "" "用 Markon 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\open_with_markon" \
    "Icon" "$INSTDIR\markon-gui.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\open_with_markon\command" \
    "" '"$INSTDIR\markon-gui.exe" "%1"'

  ; ── Directory background right-click (inside folder, on empty area) ──────
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\open_with_markon" \
    "" "用 Markon 打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\open_with_markon" \
    "Icon" "$INSTDIR\markon-gui.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\open_with_markon\command" \
    "" '"$INSTDIR\markon-gui.exe" "%W"'

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\.md\shell\open_with_markon"
  DeleteRegKey HKCU "Software\Classes\.markdown\shell\open_with_markon"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\open_with_markon"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\open_with_markon"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
