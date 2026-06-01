import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Görsel optimizasyonunu KAPAT. Paketli (asar) Electron app'te Next.js image
   * optimizer cache klasörünü açamayıp "ENOTDIR" ile patlıyor ve her görsel
   * isteğini askıda bırakıyordu → açılışta logo yüklenirken pencere ~74 sn donuyordu
   * (startup.log kanıtı). Desktop app localhost'tan servis edildiği için optimizasyona
   * zaten gerek yok; görseller doğrudan, anında servis edilir.
   */
  images: {
    unoptimized: true,
  },
  /**
   * libSQL/Turso ve Prisma native modülleri webpack tarafından BUNDLE EDİLMESİN —
   * runtime'da node_modules'tan require edilsinler (native .node + dinamik require
   * içerdikleri için webpack onları paketleyemiyor). Electron build'inde node_modules
   * zaten paketleniyor + native dosyalar asarUnpack ile çıkarılıyor.
   */
  serverExternalPackages: [
    "@prisma/adapter-libsql",
    "@libsql/client",
    "libsql",
    // mqtt (Bambu Lab LAN bağlantısı) — dinamik require + ws/tls içerir, webpack
    // bundle etmesin; runtime'da node_modules'tan require edilsin.
    "mqtt",
  ],
};

export default nextConfig;
