import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import { IZLEYICI_JS, IZLEYICI_OZETI } from "./paket.generated";

/**
 * 3B İZLEYİCİ SAYFASI — telefonun WebView'ında açılan HTML.
 *
 * Betiğin kendisi `paket.generated.ts`te (masaüstü sahne kodu + three.js, kökten
 * `node scripts/mobil-3b-paketle.mjs` ile üretilir). Burada yalnız onu taşıyan sayfa kurulur:
 *  • iOS: önbellek klasörüne `izleyici.html` + `izleyici.js` yazılır, WebView `file://` ile açar
 *    (`@expo/dom-webview` yerel dosyayı `loadFileURL` ile yüklüyor). Klasör adı paket özeti →
 *    paket değişince yeni klasör, eskisi silinir.
 *  • web (geliştirme önizlemesi): iframe `srcDoc`; mesajlar `postMessage` ile.
 *
 * ⚠️ Dosya kurulumu İLK KULLANIMDA yapılır, modül yüklenirken değil (bkz. mobile/AGENTS.md —
 * `eas update`'in web adımı modül düzeyindeki `new File(...)` yüzünden düşmüştü).
 */

/** Sayfa, telefona mesajı `ReactNativeWebView.postMessage` ile gönderir; iframe'de köprü kurulur. */
const KOPRU = `<script>if(!window.ReactNativeWebView&&window.parent!==window){window.ReactNativeWebView={postMessage:function(s){window.parent.postMessage({mlhub3b:s},"*")}}}</script>`;

const BAS = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}#kutu{position:fixed;inset:0}</style>${KOPRU}</head><body><div id="kutu"></div>`;

/** iOS: betik ayrı dosyada (560 KB'lık metni HTML'e gömmek yerine). */
const DOSYA_HTML = `${BAS}<script src="izleyici.js"></script></body></html>`;

/** Web önizleme: betik gömülü. `</script` dizisi betiği erken kapatmasın diye kaçırılır. */
export function webSayfasi(): string {
  return `${BAS}<script>${IZLEYICI_JS.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

let hazirAdres: string | null | undefined;

/**
 * iOS'ta sayfanın `file://` adresi — dosyalar yoksa yazılır. Web'de ve hata durumunda null
 * (bileşen düz görsele düşer). Senkron: yazma birkaç ms, ilk açılışta bir kez.
 */
export function izleyiciAdresi(): string | null {
  if (hazirAdres !== undefined) return hazirAdres;
  if (Platform.OS === "web") return (hazirAdres = null);
  try {
    const kok = new Directory(Paths.cache, "izleyici3b");
    const klasor = new Directory(kok, IZLEYICI_OZETI);
    const html = new File(klasor, "izleyici.html");
    const js = new File(klasor, "izleyici.js");
    if (!html.exists || !js.exists) {
      klasor.create({ intermediates: true, idempotent: true });
      js.write(IZLEYICI_JS);
      html.write(DOSYA_HTML);
      // Önceki paket sürümlerinin klasörleri (her biri ~560 KB).
      for (const oge of kok.list()) {
        if (!oge.uri.replace(/\/$/, "").endsWith(`/${IZLEYICI_OZETI}`)) {
          try {
            oge.delete();
          } catch {
            /* silinemediyse önemsiz — önbellek klasörü */
          }
        }
      }
    }
    hazirAdres = html.uri;
  } catch {
    hazirAdres = null;
  }
  return hazirAdres;
}
