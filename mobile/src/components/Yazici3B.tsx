import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";

import { Txt, useReduceMotion } from "@/components/kit";
import type { YaziciDetay } from "@core/printer-detail";
import { izleyiciAdresi, webSayfasi } from "@/lib/izleyici3b/sayfa";
import { color, radius, space } from "@/theme/tokens";

/** Sayfaya giden durum — `src/lib/gcode-viz/mobil-izleyici.ts` → `IzleyiciDurumu` ile AYNI şekil. */
interface IzleyiciDurumu {
  paketUrl: string | null;
  paketKey: string | null;
  katman: number | null;
  dosyaKonumu: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  an: number;
  basiliyor: boolean;
  duraklatildi: boolean;
  renkler: (string | null)[];
  hareketAzalt: boolean;
}

type SayfaMesaji = { tur: "sayfa-hazir" | "yukleniyor" | "cizildi" } | { tur: "hata"; mesaj: string };

/** Durumu sayfaya ilet (sayfa hazır değilse bekler — hazır olunca "sayfa-hazir" mesajıyla gider). */
function sayfayaGonder(
  json: string,
  hazir: boolean,
  web: DomWebViewRef | null,
  iframe: HTMLIFrameElement | null
): void {
  if (!hazir) return;
  if (Platform.OS === "web") {
    const w = iframe?.contentWindow as (Window & { __mlhub?: { durum: (d: unknown) => void } }) | null;
    w?.__mlhub?.durum(JSON.parse(json));
  } else {
    web?.injectJavaScript(`window.__mlhub&&window.__mlhub.durum(${json});true;`);
  }
}

function mesajiOku(ham: unknown): SayfaMesaji | null {
  try {
    const m = typeof ham === "string" ? JSON.parse(ham) : null;
    return m && typeof m.tur === "string" ? (m as SayfaMesaji) : null;
  } catch {
    return null;
  }
}

/**
 * YAZICININ CANLI 3B'Sİ — masaüstü kartındaki görünümün aynısı: basılan kısım dolu, kalanı
 * silik cam, nozul canlı yerinde, model yavaşça döner (parmakla da çevrilir).
 *
 * Sahne masaüstünün kendi kodu (paket: `lib/izleyici3b`); çizim, derlemede zaten bulunan yerel
 * WebView'da (`@expo/dom-webview`) yapılır — Expo'nun DOM bileşenleri OTA ile gelmiyor.
 * Paket (gcode'un özeti) masaüstünün R2'ye koyduğu imzalı adresten indirilir.
 */
export function Yazici3B({
  detay,
  status,
  guncellendi,
  onHata,
}: {
  detay: YaziciDetay;
  status: string;
  /** Satırın yazıldığı an (ms) — canlı ölçümün zamanı. */
  guncellendi: number;
  /** Çizilemezse ekran düz görsele döner. */
  onHata?: () => void;
}) {
  const hareketAzalt = useReduceMotion();
  const [adres] = useState(izleyiciAdresi);
  const [asama, setAsama] = useState<"bekliyor" | "yukleniyor" | "cizildi" | "hata">("bekliyor");
  const [hataMetni, setHataMetni] = useState<string | null>(null);
  const webRef = useRef<DomWebViewRef | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const sayfaHazir = useRef(false);

  const durum: IzleyiciDurumu = {
    paketUrl: detay.viz?.url ?? null,
    paketKey: detay.viz?.key ?? null,
    katman: detay.layer,
    dosyaKonumu: detay.live?.filePosition ?? null,
    x: detay.live?.x ?? null,
    y: detay.live?.y ?? null,
    z: detay.live?.z ?? null,
    an: guncellendi,
    basiliyor: status === "printing" || status === "paused",
    duraklatildi: status === "paused",
    renkler: detay.toolColors,
    hareketAzalt,
  };
  const durumJson = JSON.stringify(durum);

  const mesajGeldi = (ham: unknown) => {
    const m = mesajiOku(ham);
    if (!m) return;
    if (m.tur === "sayfa-hazir") {
      sayfaHazir.current = true;
      sayfayaGonder(durumJson, true, webRef.current, iframeRef.current);
    } else if (m.tur === "yukleniyor") {
      setAsama("yukleniyor");
    } else if (m.tur === "cizildi") {
      setAsama("cizildi");
    } else if (m.tur === "hata") {
      setAsama("hata");
      setHataMetni(m.mesaj);
      onHata?.();
    }
  };

  // Her yeni ölçüm (satır ~10 sn'de bir) sayfaya gider; sayfa aynı paketi yeniden indirmez.
  useEffect(() => {
    sayfayaGonder(durumJson, sayfaHazir.current, webRef.current, iframeRef.current);
  }, [durumJson]);

  // Web önizlemesi: iframe mesajları (yerelde mesajlar `onMessage` ile gelir). Dinleyici bir kez
  // kurulur; her mesaj en son render'ın işleyicisine gider (güncel durumla yanıt verilsin).
  const sonIsleyici = useRef(mesajGeldi);
  useEffect(() => {
    sonIsleyici.current = mesajGeldi;
  });
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const dinle = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const veri = (e.data as { mlhub3b?: unknown } | null)?.mlhub3b;
      if (veri !== undefined) sonIsleyici.current(veri);
    };
    window.addEventListener("message", dinle);
    return () => window.removeEventListener("message", dinle);
  }, []);

  const [webSrc] = useState(() => (Platform.OS === "web" ? webSayfasi() : null));

  return (
    <View style={styles.kutu}>
      {Platform.OS === "web" && webSrc ? (
        // Yalnız web önizlemesi (react-native-web DOM öğesi çizer); telefonda bu dal hiç çalışmaz.
        <iframe
          ref={iframeRef}
          srcDoc={webSrc}
          title="3B baskı"
          style={{ border: 0, width: "100%", height: "100%", background: "transparent" }}
        />
      ) : adres ? (
        <DomWebView
          ref={webRef}
          source={{ uri: adres }}
          style={styles.web}
          containerStyle={styles.web}
          scrollEnabled={false}
          bounces={false}
          onMessage={(e) => mesajGeldi(e.nativeEvent.data)}
          onContentProcessDidTerminate={() => {
            // iOS belleği geri aldı → sayfayı yeniden kur.
            sayfaHazir.current = false;
            setAsama("bekliyor");
            webRef.current?.reload();
          }}
        />
      ) : null}
      {asama !== "cizildi" ? (
        <View style={styles.ortu} pointerEvents="none">
          {asama === "hata" || (!adres && Platform.OS !== "web") ? (
            <>
              <SymbolView name="cube.transparent" tintColor={color.textFaint} style={{ width: 30, height: 30 }} />
              <Txt v="small" tone="dim" style={styles.metin}>
                {hataMetni ?? "3B görünüm açılamadı."}
              </Txt>
            </>
          ) : (
            <>
              <ActivityIndicator color={color.textDim} />
              <Txt v="small" tone="dim" style={styles.metin}>
                {asama === "yukleniyor" ? "3B model indiriliyor…" : "3B görünüm hazırlanıyor…"}
              </Txt>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  kutu: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: color.tint,
  },
  web: { flex: 1, backgroundColor: "transparent" },
  ortu: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    padding: space.lg,
  },
  metin: { textAlign: "center" },
});
