; ===========================================================================
; Magicland 3D Hub — Custom NSIS Installer Script
; ===========================================================================
; Amaç: Kurulumdan önce açık uygulama instance'larını kapatmak.
;
; KRİTİK: 'taskkill /T' (tree) KULLANMA! electron-updater installer'ı (Setup.exe)
; uygulamanın ALT process'i olarak başlatır. '/T' uygulama ağacını öldürürken
; installer'ın KENDİSİNİ de öldürür → kurulum dosya kopyalamadan ölür → güncelleme
; başarısız olur. Sadece image adıyla (uygulama exe'si) öldürüyoruz.
;
; NOT: Hem yeni ad (Magicland 3D Hub.exe) hem eski ad (Trendyol Price Optimizer.exe)
; öldürülür — eski sürümden güncelleyen kullanıcıların çalışan eski uygulaması da kapansın.
; ===========================================================================

!macro customInit
  DetailPrint "Mevcut Magicland 3D process'leri kapatiliyor..."
  nsExec::Exec 'taskkill /F /IM "Magicland 3D Hub.exe"'
  nsExec::Exec 'taskkill /F /IM "Trendyol Price Optimizer.exe"'
  Sleep 800
!macroend

!macro customInstall
  ; Dosya kopyalamadan hemen önce son bir temizlik (race condition'a karşı)
  nsExec::Exec 'taskkill /F /IM "Magicland 3D Hub.exe"'
  nsExec::Exec 'taskkill /F /IM "Trendyol Price Optimizer.exe"'
  Sleep 300
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /F /IM "Magicland 3D Hub.exe"'
  Sleep 500
!macroend
