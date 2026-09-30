; Forward Email NSIS installer hooks (bundle.windows.nsis.installerHooks).
;
; The app registers itself as a mail client for the current user when it
; starts (register_windows_mail_client in src/lib.rs) so it is listed in
; Settings > Apps > Default apps. Remove that registration on uninstall so
; Windows does not keep offering an app that is no longer installed.

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\RegisteredApplications" "Forward Email"
  DeleteRegKey HKCU "Software\Clients\Mail\Forward Email"
  DeleteRegKey HKCU "Software\Classes\net.forwardemail.mail.mailto"
!macroend
