!macro NSIS_HOOK_PREINSTALL
  StrCmp "$INSTDIR" "$LOCALAPPDATA\BetterAgentTerminal" 0 +2
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\BetterAgentTerminal"
!macroend
