#!/usr/bin/env bash
#
# macOS auto-update icin self-signed (ucretsiz) kod imzalama sertifikasi olusturur.
#
# Neden gerekli: Windows'tan farkli olarak macOS'ta electron-updater (Squirrel.Mac)
# imzasiz bir guncellemeyi imza dogrulama hatasiyla REDDEDER. Apple Developer ID ($99/yil)
# yerine kendi kendine imzalanmis bir sertifika, SADECE kendi kullanimin icin yeterlidir:
# eski ve yeni build'ler ayni sertifikayla imzalandigi surece auto-update calisir.
#
# Bu script:
#   1. codeSigning yetkili 10 yillik self-signed sertifika uretir
#   2. login keychain'e ekler (yerel build'lerin imzalayabilmesi icin)
#   3. .p12 olarak disa aktarir ve base64'unu yazar (GitHub Actions secret icin)
#
# Kullanim:
#   bash scripts/create-mac-cert.sh [P12_SIFRESI]
#
set -euo pipefail

CN="Magicland 3D Hub"            # package.json -> build.mac.identity ile AYNI olmali
P12_PASS="${1:-magicland-selfsigned}"
WORK="$(mktemp -d)"
KEY="$WORK/key.pem"
CERT="$WORK/cert.pem"
P12_OUT="mac-codesign.p12"       # .gitignore'da — repoya commitlenmez
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

echo "==> Self-signed kod imzalama sertifikasi uretiliyor: '$CN'"
openssl req -x509 -newkey rsa:2048 -keyout "$KEY" -out "$CERT" -days 3650 -nodes \
  -subj "/CN=$CN" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

echo "==> .p12 paketi olusturuluyor -> $P12_OUT"
openssl pkcs12 -export -inkey "$KEY" -in "$CERT" -out "$P12_OUT" \
  -name "$CN" -passout pass:"$P12_PASS" \
  -legacy >/dev/null 2>&1

echo "==> login keychain'e ekleniyor (yerel build icin)"
security import "$P12_OUT" -k "$LOGIN_KEYCHAIN" -P "$P12_PASS" \
  -T /usr/bin/codesign -T /usr/bin/security 2>/dev/null || \
  echo "   (zaten ekli olabilir, devam ediliyor)"

echo "==> codesign'in sertifikayi sifre sormadan kullanabilmesi icin izin veriliyor"
read -rsp "    login (Mac kullanici) sifren [bos birakirsan atlanir]: " LOGIN_PW
echo ""
if [ -n "$LOGIN_PW" ]; then
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
    -k "$LOGIN_PW" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 && \
    echo "   ok" || \
    echo "   (basarisiz - ilk build'de codesign bir kez 'Always Allow' isteyebilir)"
else
  echo "   (atlandi - ilk build'de codesign bir kez 'Always Allow' isteyebilir)"
fi

rm -rf "$WORK"

echo ""
echo "============================================================"
echo " TAMAM. Yerel imzalama hazir."
echo ""
echo " GitHub Actions icin iki secret ekle:"
echo "   Repo -> Settings -> Secrets and variables -> Actions"
echo ""
echo "   1) MAC_CSC_KEY_PASSWORD = $P12_PASS"
echo ""
echo "   2) MAC_CSC_LINK = (asagidaki base64'un TAMAMI)"
echo "------------------------------------------------------------"
base64 -i "$P12_OUT"
echo "------------------------------------------------------------"
echo ""
echo " Not: $P12_OUT dosyasi .gitignore'da; sertifikayi kaybedersen"
echo " bu script'i tekrar calistir ve secret'lari guncelle (ayni CN olmali)."
echo "============================================================"
