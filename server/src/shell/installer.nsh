; SPDX-License-Identifier: MIT
; The family's NSIS additions for electron-builder (every app's package.json:
; "nsis": { "include": "node_modules/@delebash/llm-runner/src/shell/installer.nsh" }).
;
; KEEP THE USER'S DATA. The family's default data folder lives BESIDE the exe (`data\`, and the
; Change-folder pointer `dataroot.txt`) — the user's 2026-08-14 ruling: the install directory by
; default. electron-builder's own uninstaller ends with `RMDir /r $INSTDIR`, and an UPDATE runs the
; old uninstaller first — so without this, updating the app would delete the user's database,
; logs and downloaded models (measured 2026-10-08: a silent uninstall left only `resources\`).
; The Tauri installers removed only their own files; this keeps that. Uninstall and update
; remove everything else in the install folder, and the folder itself only if it is then empty.

!macro customRemoveFiles
  SetOutPath $TEMP
  FindFirst $R0 $R1 "$INSTDIR\*.*"
  family_keepdata_loop:
    StrCmp $R1 "" family_keepdata_done
    StrCmp $R1 "." family_keepdata_next
    StrCmp $R1 ".." family_keepdata_next
    StrCmp $R1 "data" family_keepdata_next
    StrCmp $R1 "dataroot.txt" family_keepdata_next
    IfFileExists "$INSTDIR\$R1\*.*" family_keepdata_dir family_keepdata_file
  family_keepdata_dir:
    RMDir /r "$INSTDIR\$R1"
    Goto family_keepdata_next
  family_keepdata_file:
    Delete "$INSTDIR\$R1"
  family_keepdata_next:
    FindNext $R0 $R1
    Goto family_keepdata_loop
  family_keepdata_done:
  FindClose $R0
  RMDir $INSTDIR
!macroend
