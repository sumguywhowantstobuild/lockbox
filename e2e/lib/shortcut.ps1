# Presses Lockbox's default save shortcut, Ctrl+Shift+L, as real keyboard input to this session (keybd_event): Windows
# hands a registered hotkey to the app that registered it, whatever window is in front. Takes no arguments and types
# nothing else. Only for steps that may use this PC's keyboard (on CI, or with LOCKBOX_E2E_PC_FREE=1).
Add-Type -Namespace LockboxE2e -Name Keys -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
"@
$KEYUP = 2
# VK_CONTROL, VK_SHIFT, then L
[LockboxE2e.Keys]::keybd_event(0x11, 0, 0, [System.UIntPtr]::Zero)
[LockboxE2e.Keys]::keybd_event(0x10, 0, 0, [System.UIntPtr]::Zero)
[LockboxE2e.Keys]::keybd_event(0x4C, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[LockboxE2e.Keys]::keybd_event(0x4C, 0, $KEYUP, [System.UIntPtr]::Zero)
[LockboxE2e.Keys]::keybd_event(0x10, 0, $KEYUP, [System.UIntPtr]::Zero)
[LockboxE2e.Keys]::keybd_event(0x11, 0, $KEYUP, [System.UIntPtr]::Zero)
"pressed"
