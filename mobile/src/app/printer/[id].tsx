import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Pill } from "@/components/kit/Chip";
import {
  Button,
  Count,
  EmptyState,
  Glass,
  Progress,
  Ring,
  Screen,
  Segmented,
  ShimmerList,
  SubHeader,
  Tint,
  Txt,
} from "@/components/kit";
import { Yazici3B } from "@/components/Yazici3B";
import { YaziciKamerasi } from "@/components/YaziciKamerasi";
import { parseDbDate } from "@core/sqlite-date";
import type { YaziciDetay, YaziciUyarisi } from "@core/printer-detail";
import { getPrinterSnapshots, type PrinterSnapshot } from "@/lib/db/printers";
import { thumbUrl } from "@/lib/image";
import { useYaziciKomutu } from "@/lib/use-yazici-komut";
import { bitisSaati, durumBilgisi, kalanSure, katmanMetni } from "@/lib/yazici-durum";
import { color, radius, space } from "@/theme/tokens";

const MARKA_ADI: Record<string, string> = {
  bambu: "Bambu Lab",
  snapmaker: "Snapmaker",
  elegoo: "Elegoo",
  creality: "Creality",
  prusa: "Prusa",
};

const UYARI_RENGI: Record<YaziciUyarisi["level"], string> = {
  fatal: color.bad,
  serious: color.bad,
  common: color.warn,
  info: color.info,
};

/** Relay bu kadar sessiz kalırsa veri "canlı değil" sayılır (masaüstü kapalı/uyuyor). */
const BAYAT_MS = 90_000;

type Gorunum = "baski" | "3b" | "kamera";

/**
 * YAZICI EKRANI — tek yazıcının ayrıntısı: baskının görseli (alttan yukarı dolan plaka) ya da
 * canlı kamera, ilerleme + katman + bitiş saati, sıcaklıklar, filamentler, uyarılar ve komutlar.
 *
 * Veri masaüstü aktarıcısının 10 sn'de bir yazdığı satırdan gelir (`detail` JSON'u,
 * `@core/printer-detail`). Eski masaüstünde ayrıntı yoksa ilgili bölümler sessizce gizlenir.
 */
export default function YaziciEkrani() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: yazicilar, isLoading } = useQuery({
    queryKey: ["printer-snapshots"],
    queryFn: getPrinterSnapshots,
    refetchInterval: 4000,
  });
  const s = yazicilar?.find((x) => x.printerConfigId === id);

  const [simdi, setSimdi] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setSimdi(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // Kullanıcı seçmediyse: 3B paketi hazırsa 3B, değilse baskı görseli (paket sonradan da gelebilir).
  const [secim, setSecim] = useState<Gorunum | null>(null);
  const { gonder, mesgul, bant } = useYaziciKomutu(simdi);

  if (!s) {
    return (
      <Screen header={<SubHeader title="Yazıcı" />}>
        {isLoading ? (
          <ShimmerList count={3} height={140} />
        ) : (
          <EmptyState icon="printer" title="Yazıcı bulunamadı" hint="Masaüstünde devre dışı bırakılmış ya da silinmiş olabilir." />
        )}
      </Screen>
    );
  }

  const d = s.detay ?? null;
  const info = durumBilgisi(s.status, Boolean(s.online));
  const cevrimdisi = !s.online || s.status === "offline";
  const aktif = !cevrimdisi && (s.status === "printing" || s.status === "paused");
  const isVar = !cevrimdisi && (aktif || s.status === "finished" || s.status === "error");
  const bitti = s.status === "finished";
  const oran = bitti ? 1 : Math.max(0, Math.min(1, s.progress || 0));
  // Plaka görseli KATMAN oranıyla açılır (masaüstü kartıyla aynı): bayt/zaman ilerlemesi
  // katmandan 20+ puan sapabiliyor, görsel ise yüksekliği temsil ediyor.
  const katmanOrani = d?.layer && d.totalLayers ? Math.min(1, d.layer / d.totalLayers) : null;
  const gorselOrani = bitti ? 1 : (katmanOrani ?? oran);

  const guncellendi = parseDbDate(s.updatedAt)?.getTime() ?? 0;
  const yas = guncellendi > 0 ? Math.max(0, simdi - guncellendi) : 0;
  const bayat = guncellendi > 0 && yas > BAYAT_MS;

  // Kalan süre satırın yazıldığı ana göre; bitiş anı ondan sabit → saniyeler akarken zıplamaz.
  const bitisAni = aktif && s.etaSec != null && guncellendi > 0 ? guncellendi + s.etaSec * 1000 : null;
  const kalanSn = bitisAni != null && s.status === "printing" ? (bitisAni - simdi) / 1000 : aktif ? s.etaSec : null;
  const gecenSn = aktif && d?.startedAt ? (simdi - d.startedAt) / 1000 : null;

  const marka = MARKA_ADI[s.brand?.toLowerCase?.() ?? ""] ?? s.brand;
  const altBaslik = [d?.model ?? s.model, marka].filter(Boolean).join(" · ");
  // Dilimleyicinin plaka önizlemesi (masaüstü R2'ye koyar) mağaza fotoğrafını yener — tablada ne
  // olduğunu gösteren odur (masaüstü kartıyla aynı sıra).
  const gorselUri = isVar ? (d?.plateUrl ?? (s.productImage ? thumbUrl(s.productImage, 700) : null)) : null;
  const ucBoyutVar = isVar && !!d?.viz;
  const gorunum: Gorunum = secim === "3b" && !ucBoyutVar ? "baski" : (secim ?? (ucBoyutVar ? "3b" : "baski"));

  return (
    <Screen
      header={
        <SubHeader title={s.name} subtitle={altBaslik || undefined} right={<Pill color={info.color}>{info.label}</Pill>} />
      }
    >
      <View style={styles.canliSatir}>
        <View style={[styles.canliNokta, { backgroundColor: bayat ? color.warn : color.good }]} />
        <Txt v="small" tone={bayat ? "warn" : "dim"} numberOfLines={1}>
          {bayat ? `Canlı değil · ${yasMetni(yas)} — masaüstü açık mı?` : `Canlı · ${yasMetni(yas)} güncellendi`}
        </Txt>
      </View>

      {bant ? (
        <Tint strong style={[styles.bant, { borderColor: bant.renk + "66" }]}>
          <Txt v="smallStrong" style={{ color: bant.renk }}>
            {bant.metin}
          </Txt>
        </Tint>
      ) : null}

      {/* ── Görsel: baskı ya da kamera ─────────────────────────────────────────── */}
      <Glass style={{ gap: space.md }}>
        <Segmented<Gorunum>
          options={[
            { value: "baski", label: "Baskı" },
            ...(ucBoyutVar ? [{ value: "3b" as const, label: "3B" }] : []),
            { value: "kamera", label: "Kamera" },
          ]}
          value={gorunum}
          onChange={setSecim}
        />
        {gorunum === "kamera" ? (
          <YaziciKamerasi yaziciId={s.printerConfigId} yaziciAdi={s.name} />
        ) : gorunum === "3b" && d ? (
          <Yazici3B detay={d} status={s.status} guncellendi={guncellendi} />
        ) : (
          <BaskiGorseli
            uri={gorselUri}
            oran={gorselOrani}
            renk={info.color}
            cevrimdisi={cevrimdisi}
            etiket={s.productName ?? s.currentFilename ?? "Baskı"}
          />
        )}
        <View style={{ gap: 2 }}>
          <Txt v="bodyStrong" numberOfLines={2}>
            {isVar ? (s.productName ?? s.currentFilename ?? "Baskı") : cevrimdisi ? "Bağlantı yok" : "Yeni baskıya hazır"}
          </Txt>
          {isVar && s.currentFilename && s.currentFilename !== s.productName ? (
            <Txt v="small" tone="faint" numberOfLines={1}>
              {s.currentFilename}
            </Txt>
          ) : null}
        </View>
      </Glass>

      {/* ── Durum nedeni ve uyarılar ─────────────────────────────────────────── */}
      <Uyarilar s={s} d={d} />

      {/* ── İlerleme ─────────────────────────────────────────────────────────── */}
      {isVar ? (
        <Glass style={{ gap: space.md }}>
          <View style={styles.ilerlemeUst}>
            <Count value={oran * 100} v="stat" style={{ color: info.color }} format={(n) => `%${Math.round(n)}`} />
            {katmanMetni(d?.layer, d?.totalLayers) ? (
              <View style={{ alignItems: "flex-end" }}>
                <Txt v="label" tone="faint">
                  KATMAN
                </Txt>
                <Txt v="heading" num>
                  {katmanMetni(d?.layer, d?.totalLayers)}
                </Txt>
              </View>
            ) : null}
          </View>
          <Progress value={oran} color={info.color} height={10} />
          <View style={styles.istatistikler}>
            <Istatistik etiket="KALAN" deger={aktif ? (kalanSure(kalanSn) ?? "—") : bitti ? "Bitti" : "—"} />
            <Istatistik
              etiket="BİTİŞ"
              deger={s.status === "printing" && bitisAni ? (bitisSaati((bitisAni - simdi) / 1000, simdi) ?? "—") : "—"}
            />
            <Istatistik etiket="GEÇEN" deger={kalanSure(gecenSn) ?? "—"} />
          </View>
        </Glass>
      ) : null}

      {/* ── Komutlar ─────────────────────────────────────────────────────────── */}
      {aktif && !bayat ? (
        <View style={[styles.komutlar, mesgul ? { opacity: 0.45 } : null]}>
          {s.status === "printing" ? (
            <Button label="Duraklat" icon="pause.fill" variant="secondary" disabled={mesgul} onPress={() => gonder(s, "pause")} style={{ flex: 1 }} />
          ) : (
            <Button label="Devam" icon="play.fill" disabled={mesgul} onPress={() => gonder(s, "resume")} style={{ flex: 1 }} />
          )}
          <Button label="İptal" icon="stop.fill" variant="danger" disabled={mesgul} onPress={() => gonder(s, "cancel")} style={{ flex: 1 }} />
        </View>
      ) : null}

      {/* ── Sıcaklıklar ──────────────────────────────────────────────────────── */}
      {!cevrimdisi ? <Sicakliklar s={s} d={d} /> : null}

      {/* ── Filament ─────────────────────────────────────────────────────────── */}
      {d && (d.slots.length > 0 || d.filamentType) ? <Filamentler d={d} isVar={isVar} /> : null}

      {/* ── İş ayrıntıları ───────────────────────────────────────────────────── */}
      {d && (d.speed || d.currentObject || (isVar && d.filamentGrams)) ? (
        <Glass style={{ gap: space.sm }}>
          <Txt v="label" tone="faint">
            AYRINTILAR
          </Txt>
          {d.speed ? <Satir etiket="Hız" deger={d.speed} /> : null}
          {isVar && d.filamentGrams ? <Satir etiket="Filament" deger={`${d.filamentGrams} g`} /> : null}
          {d.currentObject ? <Satir etiket="Basılan parça" deger={d.currentObject} /> : null}
        </Glass>
      ) : null}
    </Screen>
  );
}

function yasMetni(ms: number): string {
  const sn = Math.floor(ms / 1000);
  if (sn < 10) return "az önce";
  if (sn < 60) return `${sn} sn önce`;
  const dk = Math.floor(sn / 60);
  if (dk < 60) return `${dk} dk önce`;
  return `${Math.floor(dk / 60)} sa önce`;
}

/**
 * Baskının görseli alttan yukarı AÇILIR — tamamı soluk, basılan yüksekliğe kadar tam renk,
 * sınırda baskı düzlemi çizgisi (masaüstü kartındaki "BuildReveal"in telefon hâli).
 */
function BaskiGorseli({
  uri,
  oran,
  renk,
  cevrimdisi,
  etiket,
}: {
  uri: string | null;
  oran: number;
  renk: string;
  cevrimdisi: boolean;
  etiket: string;
}) {
  const [yukseklik, setYukseklik] = useState(0);
  const p = Math.max(0, Math.min(1, oran));
  if (!uri) {
    // Görsel yoksa (eşleşmemiş iş, boştaki yazıcı) boş kutu yerine büyük ilerleme halkası.
    return (
      <View style={[styles.gorselKutu, styles.gorselBos]}>
        <Ring value={cevrimdisi ? 0 : p} size={132} stroke={10} color={renk}>
          {cevrimdisi ? (
            <SymbolView name="wifi.slash" tintColor={color.textFaint} style={{ width: 34, height: 34 }} />
          ) : p > 0 ? (
            <Count value={p * 100} v="title" style={{ color: renk }} format={(n) => `%${Math.round(n)}`} />
          ) : (
            <SymbolView name="printer.fill" tintColor={renk} style={{ width: 38, height: 38 }} />
          )}
        </Ring>
      </View>
    );
  }
  return (
    <View style={styles.gorselKutu} onLayout={(e) => setYukseklik(e.nativeEvent.layout.height)}>
      <Image source={{ uri }} style={[StyleSheet.absoluteFill, { opacity: 0.22 }]} contentFit="contain" accessibilityLabel={etiket} />
      <View style={[styles.acilan, { height: `${p * 100}%` }]}>
        {yukseklik > 0 ? (
          <Image
            source={{ uri }}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: yukseklik }}
            contentFit="contain"
          />
        ) : null}
      </View>
      {p > 0.005 && p < 0.995 ? <View style={[styles.duzlem, { bottom: `${p * 100}%`, backgroundColor: renk }]} /> : null}
    </View>
  );
}

function Istatistik({ etiket, deger }: { etiket: string; deger: string }) {
  return (
    <View style={styles.istatistik}>
      <Txt v="label" tone="faint">
        {etiket}
      </Txt>
      <Txt v="bodyStrong" num numberOfLines={1}>
        {deger}
      </Txt>
    </View>
  );
}

function Satir({ etiket, deger }: { etiket: string; deger: string }) {
  return (
    <View style={styles.satir}>
      <Txt v="small" tone="dim">
        {etiket}
      </Txt>
      <Txt v="smallStrong" numberOfLines={1} style={{ flexShrink: 1, textAlign: "right" }}>
        {deger}
      </Txt>
    </View>
  );
}

/** Duraklama/hata nedeni + yazıcının kendi uyarıları (Bambu HMS, U1 spagetti/kirli tabla…). */
function Uyarilar({ s, d }: { s: PrinterSnapshot; d: YaziciDetay | null }) {
  const liste: YaziciUyarisi[] = [...(d?.warnings ?? [])];
  // Eski masaüstünde ayrıntı yok: neden yalnız statusMessage'ta.
  if (!d && s.statusMessage && (s.status === "error" || s.status === "paused")) {
    liste.push({ code: null, level: s.status === "error" ? "serious" : "common", text: s.statusMessage });
  }
  if (!liste.length) return null;
  return (
    <View style={{ gap: space.sm }}>
      {liste.map((u, i) => {
        const renk = UYARI_RENGI[u.level];
        return (
          <Tint key={`${u.code ?? "m"}-${i}`} strong style={[styles.uyari, { borderColor: renk + "55" }]}>
            <SymbolView
              name={u.level === "info" ? "info.circle.fill" : "exclamationmark.triangle.fill"}
              tintColor={renk}
              style={{ width: 18, height: 18 }}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="smallStrong" style={{ color: renk }}>
                {u.text}
              </Txt>
              {u.code ? (
                <Txt v="label" tone="faint" num>
                  Kod {u.code}
                </Txt>
              ) : null}
            </View>
          </Tint>
        );
      })}
    </View>
  );
}

function Sicakliklar({ s, d }: { s: PrinterSnapshot; d: YaziciDetay | null }) {
  const kafalar = d?.heads ?? [];
  const hedefMetni = (h: number | null | undefined) => (h && h > 0 ? ` / ${Math.round(h)}°` : "");
  const isiniyor = (t: number, h: number | null | undefined) => !!h && h > 0 && t < h - 3;
  return (
    <Glass style={{ gap: space.md }}>
      <Txt v="label" tone="faint">
        SICAKLIK
      </Txt>
      <View style={styles.sicaklikSatiri}>
        <SicaklikKutusu
          ikon="flame.fill"
          etiket={kafalar.length > 1 ? "Aktif nozül" : "Nozül"}
          deger={`${Math.round(s.nozzle)}°${hedefMetni(d?.nozzleTarget)}`}
          isiniyor={isiniyor(s.nozzle, d?.nozzleTarget)}
        />
        <SicaklikKutusu
          ikon="square.3.layers.3d.down.right"
          etiket="Tabla"
          deger={`${Math.round(s.bed)}°${hedefMetni(d?.bedTarget)}`}
          isiniyor={isiniyor(s.bed, d?.bedTarget)}
        />
      </View>
      {kafalar.length > 1 ? (
        <View style={styles.kafalar}>
          {kafalar.map((k) => {
            const slot = d?.slots.find((x) => x.slot === k.index);
            return (
              <View key={k.index} style={[styles.kafa, k.active ? { borderColor: color.accentBright } : null]}>
                <View style={styles.kafaUst}>
                  {slot?.color ? <View style={[styles.renkNokta, { backgroundColor: slot.color }]} /> : null}
                  <Txt v="label" tone={k.active ? "accent" : "faint"}>
                    T{k.index}
                  </Txt>
                </View>
                <Txt v="smallStrong" num>
                  {Math.round(k.temp)}°
                </Txt>
                {k.target > 0 ? (
                  <Txt v="label" tone="faint" num>
                    → {Math.round(k.target)}°
                  </Txt>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </Glass>
  );
}

function SicaklikKutusu({
  ikon,
  etiket,
  deger,
  isiniyor,
}: {
  ikon: "flame.fill" | "square.3.layers.3d.down.right";
  etiket: string;
  deger: string;
  isiniyor: boolean;
}) {
  return (
    <View style={styles.sicaklik}>
      <SymbolView name={ikon} tintColor={isiniyor ? color.warn : color.textDim} style={{ width: 18, height: 18 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt v="label" tone="faint" numberOfLines={1}>
          {etiket}
          {isiniyor ? " · ısınıyor" : ""}
        </Txt>
        <Txt v="heading" num numberOfLines={1}>
          {deger}
        </Txt>
      </View>
    </View>
  );
}

function Filamentler({ d, isVar }: { d: YaziciDetay; isVar: boolean }) {
  return (
    <Glass style={{ gap: space.md }}>
      <View style={styles.satir}>
        <Txt v="label" tone="faint">
          FİLAMENT
        </Txt>
        {isVar && d.filamentType ? (
          <Txt v="smallStrong" tone="dim">
            {d.filamentType}
          </Txt>
        ) : null}
      </View>
      {d.slots.length ? (
        <View style={styles.slotlar}>
          {d.slots.map((sl) => (
            <View
              key={sl.slot}
              style={[styles.slot, sl.active ? { borderColor: color.accentBright, backgroundColor: color.accentSoft } : null]}
            >
              <View
                style={[
                  styles.slotRenk,
                  sl.empty || !sl.color
                    ? { backgroundColor: "transparent", borderWidth: 1, borderColor: color.lineStrong, borderStyle: "dashed" }
                    : { backgroundColor: sl.color },
                ]}
              />
              <Txt v="label" tone={sl.active ? "accent" : "dim"} numberOfLines={1}>
                {sl.empty ? "Boş" : sl.type || "—"}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
    </Glass>
  );
}

const styles = StyleSheet.create({
  canliSatir: { flexDirection: "row", alignItems: "center", gap: 7 },
  canliNokta: { width: 7, height: 7, borderRadius: 4 },
  bant: { padding: space.md, borderWidth: 1 },
  gorselKutu: {
    width: "100%",
    aspectRatio: 16 / 10,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: color.tint,
  },
  gorselBos: { alignItems: "center", justifyContent: "center" },
  acilan: { position: "absolute", left: 0, right: 0, bottom: 0, overflow: "hidden" },
  duzlem: { position: "absolute", left: space.sm, right: space.sm, height: 2, borderRadius: 1, opacity: 0.9 },
  ilerlemeUst: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  istatistikler: { flexDirection: "row", gap: space.sm },
  istatistik: {
    flex: 1,
    gap: 2,
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.tint,
  },
  komutlar: { flexDirection: "row", gap: space.sm },
  uyari: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderWidth: 1 },
  sicaklikSatiri: { flexDirection: "row", gap: space.sm },
  sicaklik: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.tint,
  },
  kafalar: { flexDirection: "row", gap: space.sm },
  kafa: {
    flex: 1,
    alignItems: "center",
    gap: 2,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.tint,
  },
  kafaUst: { flexDirection: "row", alignItems: "center", gap: 4 },
  renkNokta: { width: 8, height: 8, borderRadius: 4 },
  slotlar: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  slot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.tint,
  },
  slotRenk: { width: 14, height: 14, borderRadius: 7 },
  satir: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
});
