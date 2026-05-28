import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * libSQL/Turso ve Prisma native modülleri webpack tarafından BUNDLE EDİLMESİN —
   * runtime'da node_modules'tan require edilsinler (native .node + dinamik require
   * içerdikleri için webpack onları paketleyemiyor). Electron build'inde node_modules
   * zaten paketleniyor + native dosyalar asarUnpack ile çıkarılıyor.
   */
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-libsql",
    "@libsql/client",
    "libsql",
  ],
};

export default nextConfig;
