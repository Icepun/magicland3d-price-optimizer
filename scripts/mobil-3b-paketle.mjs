/**
 * TELEFONUN 3B İZLEYİCİSİNİ PAKETLE.
 *
 * `src/lib/gcode-viz/mobil-izleyici.ts`'i (masaüstünün sahne modülleri + three.js) TEK bir
 * tarayıcı betiğine derler ve `mobile/src/lib/izleyici3b/paket.generated.ts` içine metin olarak
 * yazar. Telefon onu yerel bir HTML dosyasına koyup derlemede zaten bulunan WebView'da açar
 * (Expo DOM bileşenleri OTA ile gelmiyor — yalnız native derlemeye gömülüyor).
 *
 * Çalıştır:  node scripts/mobil-3b-paketle.mjs
 *
 * ⚠️ `mobile/package.json`'a BETİK OLARAK EKLEME: betikler çalışma parmak izine giriyor, yeni
 * betik OTA kanalını sessizce keser (bkz. mobile/AGENTS.md). Bu dosya kökten elle çalıştırılır.
 * Kök testi (`src/lib/mobile-izleyici3b.test.ts`) aynı derlemeyi yapıp özeti karşılaştırır:
 * sahne kodu değişip paket yenilenmezse test kırmızıya döner.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CIKTI = path.join(KOK, "mobile/src/lib/izleyici3b/paket.generated.ts");

/** Derleme — test de AYNI fonksiyonu çağırır (özet ancak aynı ayarlarla anlamlı). */
export async function izleyiciyiDerle() {
  const sonuc = await build({
    stdin: {
      contents: `import { izleyiciyiBaslat } from "./src/lib/gcode-viz/mobil-izleyici";
izleyiciyiBaslat(document.getElementById("kutu"));`,
      resolveDir: KOK,
      loader: "ts",
      sourcefile: "mobil-izleyici-giris.ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    // iOS 15+ WKWebView.
    target: "safari15",
    minify: true,
    legalComments: "none",
    write: false,
    tsconfig: path.join(KOK, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const js = sonuc.outputFiles[0].text;
  const ozet = crypto.createHash("sha256").update(js).digest("hex").slice(0, 16);
  return { js, ozet };
}

const dogrudanCalisti = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (dogrudanCalisti) {
  const { js, ozet } = await izleyiciyiDerle();
  const govde = `// ⚠️ OTOMATİK ÜRETİLDİ — ELLE DÜZENLEME. Kaynak: src/lib/gcode-viz/mobil-izleyici.ts
// Yeniden üret: node scripts/mobil-3b-paketle.mjs  (kökten)

/** Paket içeriğinin özeti — dosya adı olarak da kullanılır (içerik değişince yeni dosya). */
export const IZLEYICI_OZETI = ${JSON.stringify(ozet)};

/** three.js dahil tek betik (${(js.length / 1024).toFixed(0)} KB). */
export const IZLEYICI_JS = ${JSON.stringify(js)};
`;
  const hedef = process.argv[2] ? path.resolve(process.argv[2]) : CIKTI;
  fs.mkdirSync(path.dirname(hedef), { recursive: true });
  fs.writeFileSync(hedef, govde);
  console.log(`izleyici paketlendi: ${(js.length / 1024).toFixed(0)} KB, özet ${ozet} → ${path.relative(KOK, hedef)}`);
}
