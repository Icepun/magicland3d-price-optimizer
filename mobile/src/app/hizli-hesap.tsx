import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { SymbolView } from "expo-symbols";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";

import { parsePackagingSettings } from "@core/packaging";
import { fiyatDagilimi, hizliHesapla, sayiOku, type HizliHesapBaglam, type HizliPlatform } from "@core/hizli-hesap";
import type { SimulationResult } from "@core/types";
import { Chip } from "@/components/kit/Chip";
import {
  Count,
  ErrorState,
  FadeInView,
  IconButton,
  Input,
  Money,
  PressableScale,
  Screen,
  Segmented,
  Shimmer,
  SubHeader,
  Tint,
  Txt,
  useReduceMotion,
} from "@/components/kit";
import { getFilamentTypes, type FilamentType } from "@/lib/db/cost-save";
import { getSikKomisyonlar } from "@/lib/db/hizli-hesap";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { formatCurrency, formatPercent } from "@/lib/format";
import { BOS_FORM, formdanGirdi, hizliHesapBaglami, sayiMetni, type HizliForm } from "@/lib/hizli-hesap";
import { formuOku, formuYaz } from "@/lib/hizli-hesap-kayit";
import { PLATFORM_LABEL } from "@/lib/platforms";
import type { Rules } from "@/lib/profit";
import { color, motion, radius, space } from "@/theme/tokens";

/**
 * HIZLI HESAP — ürünü kaydetmeden "bu fiyattan satarsam ne kalır?".
 *
 * Masaüstündeki Hızlı hesabın telefon karşılığı. Hesap çekirdekte (`@core/hizli-hesap` →
 * `@core/client-pricing`), yani rakamlar masaüstünün hızlı hesabı ve ürün ekranıyla birebir aynı.
 * Fiyat ve sonuç alttaki çubukta durur; klavye açılınca onunla birlikte yükselir.
 */

const PLATFORMLAR: HizliPlatform[] = ["trendyol", "hepsiburada", "shopify"];

const NAYLON = [
  { value: "none", label: "Yok" },
  { value: "low", label: "Az" },
  { value: "medium", label: "Orta" },
  { value: "high", label: "Çok" },
];

/** Fiyat çubuğunun dilim renkleri — döküm satırlarındaki noktalarla aynı (lejant görevi). */
const DILIM: Record<"maliyet" | "komisyon" | "kargo" | "gider" | "kdv" | "kar", { ad: string; renk: string }> = {
  maliyet: { ad: "Ürün + paketleme", renk: color.accent },
  komisyon: { ad: "Komisyon", renk: "#D77CF0" },
  kargo: { ad: "Kargo", renk: color.info },
  gider: { ad: "Hizmet bedeli", renk: "#4FC3C8" },
  kdv: { ad: "KDV (net)", renk: color.textFaint },
  kar: { ad: "Net kâr", renk: color.good },
};

const FORM_TWEEN = 340;

function yuzdeMetni(n: number): string {
  return String(n).replace(".", ",");
}

/**
 * Üç sorguyu tek, KARARLI bir bağlama çevirir. React Query `combine` sonucunu yalnız sorgular
 * değişince yeniden kurar → bağlam her çizimde yeni nesne olmaz ve hedef fiyat bileşeni fiyat
 * yazarken yeniden hesap yapmaz. (Modül düzeyinde tanımlı olmalı: referansı sabit kalsın.)
 */
function baglamiBirlestir([f, a, k]: [
  UseQueryResult<FilamentType[]>,
  UseQueryResult<Record<string, string>>,
  UseQueryResult<Rules>,
]) {
  return {
    baglam: f.data && a.data && k.data ? hizliHesapBaglami(f.data, a.data, k.data) : null,
    filamentler: f.data,
    ayarlar: a.data,
    hata: f.error ?? a.error ?? k.error,
    yenileniyor: f.isFetching || a.isFetching || k.isFetching,
    yenile: () => {
      void f.refetch();
      void a.refetch();
      void k.refetch();
    },
  };
}

export default function HizliHesapEkrani() {
  const [form, setForm] = useState<HizliForm>(formuOku);
  const [ayrinti, setAyrinti] = useState(false);

  // Girdiler bu telefonda hatırlanır; her tuşta değil, yazma durunca diske yazılır.
  useEffect(() => {
    const t = setTimeout(() => formuYaz(form), 400);
    return () => clearTimeout(t);
  }, [form]);

  // Titreşimi kit'in dokunulabilir yüzeyleri (Chip, Tint, IconButton) zaten veriyor.
  const set = <K extends keyof HizliForm>(k: K, v: HizliForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  // Ürün ve maliyet ekranlarıyla AYNI sorgu anahtarları → önbellek paylaşılır, ekran anında hazır.
  const veri = useQueries({
    queries: [
      { queryKey: ["filaments"], queryFn: getFilamentTypes },
      { queryKey: ["settings"], queryFn: getSettingsMap },
      { queryKey: ["rules"], queryFn: getRules },
    ],
    combine: baglamiBirlestir,
  });
  const sikQ = useQuery({ queryKey: ["hizli-hesap-komisyon"], queryFn: getSikKomisyonlar, staleTime: 10 * 60_000 });

  const { baglam, hata } = veri;
  const filamentler = veri.filamentler ?? [];
  const paketler = veri.ayarlar ? parsePackagingSettings(veri.ayarlar).options : [];
  const shopifyVarsayilan = Number(veri.ayarlar?.shopifyCommissionRate ?? 3.2);

  const girdi = formdanGirdi(form);
  const kar = baglam ? hizliHesapla(girdi, baglam, { hedefler: false }) : null;

  // Hedef fiyatlar ikili arama yapar (pahalı) → ayrı bileşende, fiyat DIŞINDAKİ girdilerin metin
  // anahtarıyla. Anahtar ve bağlam aynı kaldıkça bileşen yeniden çizilmez: fiyat yazarken arama koşmaz.
  // Shopify'da sepet minimumunun üstündeki fiyatın hedefi de üstünde aranır (ürün ekranıyla aynı kural).
  const hedefAnahtari = JSON.stringify({
    ...girdi,
    fiyat: girdi.platform === "shopify" && (girdi.fiyat ?? 0) >= 150 ? girdi.fiyat : null,
  });

  const sonuc = kar?.sonuc ?? null;
  const maliyetBiliniyor = kar?.maliyet.biliniyor ?? false;
  const zarar = sonuc ? sonuc.netProfit < 0 : false;
  const ince = sonuc ? !zarar && sonuc.profitMargin < 0.1 : false;
  const karTonu = zarar ? "bad" : ince ? "warn" : "good";
  const komisyonMetni = form.komisyon[form.platform];
  const sik = form.platform === "shopify" ? [] : (sikQ.data?.[form.platform] ?? []);
  const komisyonEtiketi =
    girdi.komisyonPct != null
      ? ` (%${yuzdeMetni(girdi.komisyonPct)})`
      : form.platform === "shopify"
        ? ` (%${yuzdeMetni(shopifyVarsayilan)})`
        : "";

  const komisyonYaz = (v: string) => setForm((f) => ({ ...f, komisyon: { ...f.komisyon, [f.platform]: v } }));

  const sifirla = () => {
    // Filament, paketleme ve komisyonlar kalır (çoğu ürün aynı); ürüne özgü alanlar temizlenir.
    setForm((f) => ({
      ...BOS_FORM,
      platform: f.platform,
      filamentTypeId: f.filamentTypeId,
      paket: f.paket,
      naylon: f.naylon,
      bant: f.bant,
      fire: f.fire,
      komisyon: f.komisyon,
    }));
  };

  const paketAdi = paketler.find((o) => o.id === form.paket)?.name ?? "paketsiz";

  return (
    <Screen
      scroll={false}
      padded={false}
      edges={["top", "bottom"]}
      header={
        <SubHeader
          title="Hızlı hesap"
          subtitle="Ürünü kaydetmeden fiyat dene"
          right={<IconButton icon="arrow.counterclockwise" onPress={sifirla} accessibilityLabel="Ürün bilgilerini temizle" />}
        />
      }
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.icerik}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {hata && !baglam ? (
            <ErrorState
              error={hata}
              onRetry={veri.yenile}
              retrying={veri.yenileniyor}
            />
          ) : null}

          <Segmented
            options={PLATFORMLAR.map((p) => ({ value: p, label: PLATFORM_LABEL[p] }))}
            value={form.platform}
            onChange={(p) => set("platform", p)}
          />

          <Tint strong style={styles.kart}>
            <Etiket>FİLAMENT</Etiket>
            {veri.filamentler ? (
              <ChipSatiri
                items={filamentler.map((f) => ({ key: f.id, label: `${f.name} · ${formatCurrency(f.costPerGram)}/g` }))}
                selected={form.filamentTypeId}
                onSelect={(k) => set("filamentTypeId", k)}
              />
            ) : (
              <Shimmer height={34} radius={radius.pill} />
            )}
            <View style={styles.ikiSutun}>
              <SayiAlani etiket="Gramaj" birim="g" yer="örn. 85" deger={form.gram} onDegis={(v) => set("gram", v)} />
              <SayiAlani etiket="Desi" yer="örn. 2" deger={form.desi} onDegis={(v) => set("desi", v)} />
            </View>
            <View style={styles.ikiSutun}>
              <SayiAlani etiket="Baskı süresi" birim="sa" yer="0" deger={form.saat} onDegis={(v) => set("saat", v)} />
              <SayiAlani etiket=" " birim="dk" yer="0" deger={form.dakika} onDegis={(v) => set("dakika", v)} />
            </View>
          </Tint>

          <Tint strong style={styles.kart}>
            <SayiAlani
              etiket="Komisyon"
              birim="%"
              yer={form.platform === "shopify" ? yuzdeMetni(shopifyVarsayilan) : "örn. 21"}
              deger={komisyonMetni}
              onDegis={komisyonYaz}
            />
            {sik.length > 0 ? (
              <FadeInView>
                <ChipSatiri
                  items={sik.map((y) => ({ key: String(y), label: `%${yuzdeMetni(y)}` }))}
                  selected={sayiOku(komisyonMetni) != null ? String(sayiOku(komisyonMetni)) : null}
                  onSelect={(k) => komisyonYaz(yuzdeMetni(Number(k)))}
                />
              </FadeInView>
            ) : null}
          </Tint>

          {/* Fire ve paketleme — çoğu üründe aynı, kapalı durur */}
          <Tint strong style={styles.kart}>
            <PressableScale
              onPress={() => setAyrinti((a) => !a)}
              style={styles.ayrintiBaslik}
              accessibilityRole="button"
              accessibilityLabel="Fire ve paketleme"
              accessibilityState={{ expanded: ayrinti }}
            >
              <Txt v="smallStrong" tone="dim" style={{ flex: 1 }} numberOfLines={1}>
                Fire ve paketleme
                <Txt v="small" tone="faint">{`  ·  %${form.fire || "0"}  ·  ${paketAdi}`}</Txt>
              </Txt>
              <SymbolView
                name={ayrinti ? "chevron.up" : "chevron.down"}
                tintColor={color.textFaint}
                style={{ width: 14, height: 14 }}
              />
            </PressableScale>
            {ayrinti ? (
              <FadeInView style={styles.kart}>
                <View style={styles.ikiSutun}>
                  <SayiAlani etiket="Fire" birim="%" yer="0" deger={form.fire} onDegis={(v) => set("fire", v)} />
                  <View style={{ flex: 1 }} />
                </View>
                <Etiket>POŞET / KOLİ</Etiket>
                <ChipSatiri
                  items={[{ key: "", label: "Yok" }, ...paketler.map((o) => ({ key: o.id, label: o.name }))]}
                  selected={form.paket}
                  onSelect={(k) => set("paket", k)}
                />
                <Etiket>NAYLON</Etiket>
                <Segmented options={NAYLON} value={form.naylon} onChange={(k) => set("naylon", k)} />
                <Etiket>BANT</Etiket>
                <Segmented
                  options={[
                    { value: "hayir", label: "Yok" },
                    { value: "evet", label: "Var" },
                  ]}
                  value={form.bant ? "evet" : "hayir"}
                  onChange={(k) => set("bant", k === "evet")}
                />
              </FadeInView>
            ) : null}
          </Tint>

          {!baglam && !hata ? (
            <View style={{ gap: space.sm }}>
              {[0, 1, 2].map((i) => (
                <Shimmer key={i} height={40} radius={radius.sm} delay={i * 120} />
              ))}
            </View>
          ) : null}

          {/* Maliyet özeti */}
          {kar && maliyetBiliniyor ? (
            <FadeInView>
              <Tint style={styles.maliyet}>
                <Txt v="small" tone="dim">
                  Ürün maliyeti
                </Txt>
                <View style={{ alignItems: "flex-end" }}>
                  <Money value={kar.maliyet.toplam} v="bodyStrong" durationMs={FORM_TWEEN} />
                  <Txt v="small" tone="faint" num>
                    üretim {formatCurrency(kar.maliyet.uretim)} + paket {formatCurrency(kar.maliyet.paketleme)}
                  </Txt>
                </View>
              </Tint>
            </FadeInView>
          ) : null}

          {/* Hedef fiyatlar — dokun, fiyat olarak gelsin */}
          {baglam && maliyetBiliniyor ? (
            <HedefFiyatlar baglam={baglam} anahtar={hedefAnahtari} setForm={setForm} />
          ) : null}

          {/* Döküm */}
          {sonuc ? (
            <FadeInView>
              <Tint style={styles.dokum}>
                {sonuc.minOrderQty > 1 ? (
                  <Txt v="small" tone="warn">
                    Trendyol bu fiyatta en az {sonuc.minOrderQty} adet sattırır — rakamlar {sonuc.minOrderQty} adet için.
                  </Txt>
                ) : null}
                <Satir renk={DILIM.maliyet.renk} ad="Ürün + paketleme" tutar={sonuc.productCost + sonuc.packagingCost} />
                <Satir renk={DILIM.komisyon.renk} ad={`Komisyon${komisyonEtiketi}`} tutar={sonuc.commissionCost} />
                <Satir renk={DILIM.kargo.renk} ad="Kargo" tutar={sonuc.cargoCost} />
                {sonuc.appliedExpenseRules
                  .filter((x) => x.amount !== 0)
                  .map((x) => (
                    <Satir
                      key={x.id}
                      renk={DILIM.gider.renk}
                      ad={x.name}
                      tutar={x.type === "percentage" ? x.amount * sonuc.minOrderQty : x.amount}
                    />
                  ))}
                {sonuc.adCost > 0 ? <Satir renk={DILIM.gider.renk} ad="Reklam payı" tutar={sonuc.adCost} /> : null}
                <Satir
                  renk={DILIM.kdv.renk}
                  ad={`KDV (%${sonuc.vatRate}, iade düşülmüş)`}
                  tutar={sonuc.vatAmount * sonuc.minOrderQty - sonuc.inputVatCredit}
                />
                <View style={[styles.satir, styles.netSatir]}>
                  <View style={[styles.nokta, { backgroundColor: DILIM.kar.renk }]} />
                  <Txt v="bodyStrong" style={{ flex: 1 }}>
                    Net kâr
                  </Txt>
                  <Txt v="bodyStrong" tone={karTonu} num>
                    {formatCurrency(sonuc.netProfit)}
                  </Txt>
                </View>
              </Tint>
            </FadeInView>
          ) : null}

          {/* Uyarılar — kısa, ne yapacağını söyler */}
          {kar ? (
            <View style={{ gap: space.xs }}>
              {!maliyetBiliniyor ? <Uyari>Filament seç ve gramajı gir.</Uyari> : null}
              {maliyetBiliniyor && kar.desiVarsayildi ? <Uyari>Desi girilmedi — 1 desi sayıldı.</Uyari> : null}
              {kar.kargoFiyatiYok ? <Uyari kirmizi>Bu desiye uyan kargo fiyatı yok — kargo ₺0 sayıldı.</Uyari> : null}
              {form.platform !== "shopify" && girdi.komisyonPct == null && maliyetBiliniyor ? (
                <Uyari>Komisyonu gir — boşken komisyon kesilmez.</Uyari>
              ) : null}
            </View>
          ) : null}
        </ScrollView>

        {/* Sabit alt çubuk: fiyat + sonuç her zaman görünür, klavyeyle birlikte yükselir */}
        <View style={styles.altCubuk}>
          <View style={styles.altSatir}>
            <View style={styles.fiyatAlani}>
              <Txt v="label" tone="faint" style={styles.etiket}>
                SATIŞ FİYATI
              </Txt>
              <Input
                value={form.fiyat}
                onChangeText={(v) => set("fiyat", sayiMetni(v))}
                numeric
                placeholder="0,00"
                suffix="₺"
                selectTextOnFocus
                accessibilityLabel="Satış fiyatı, KDV dahil"
                inputStyle={styles.fiyatGirisi}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Txt v="label" tone="faint" style={styles.etiket}>
                NET KÂR
              </Txt>
              {sonuc ? (
                <Money value={sonuc.netProfit} v="heading" tone={karTonu} durationMs={FORM_TWEEN} />
              ) : (
                <Txt v="heading" tone="faint">
                  —
                </Txt>
              )}
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Txt v="label" tone="faint" style={styles.etiket}>
                MARJ
              </Txt>
              {sonuc ? (
                <Count
                  value={sonuc.profitMargin}
                  format={(n) => formatPercent(n)}
                  v="heading"
                  tone={karTonu}
                  durationMs={FORM_TWEEN}
                />
              ) : (
                <Txt v="heading" tone="faint">
                  —
                </Txt>
              )}
            </View>
          </View>
          <FiyatCubugu sonuc={sonuc} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * Hedef marjlar için en düşük fiyatlar. Yalnız `anahtar` (fiyat dışı girdiler) ya da bağlam değişince
 * hesaplar. ⚠️ Prop'lar kimliği sabit olmalı (`setForm` React'in kendisi verir): satır içi bir geri
 * çağırma her çizimde yeni olur ve derleyici ikili aramayı fiyatın her tuşunda yeniden koşar.
 */
function HedefFiyatlar({
  baglam,
  anahtar,
  setForm,
}: {
  baglam: HizliHesapBaglam;
  anahtar: string;
  setForm: Dispatch<SetStateAction<HizliForm>>;
}) {
  const hedefler = hizliHesapla(JSON.parse(anahtar), baglam).hedefler;
  if (hedefler.length === 0) return null;
  return (
    <View style={{ gap: space.sm }}>
      <View style={styles.satir}>
        <SymbolView name="scope" tintColor={color.textFaint} style={{ width: 14, height: 14 }} />
        <Txt v="small" tone="faint">
          Bu marj için en düşük fiyat
        </Txt>
      </View>
      <View style={styles.hedefler}>
        {hedefler.map((h, i) => (
          <FadeInView key={h.marj} index={i} style={{ flex: 1 }}>
            <Tint
              strong
              onPress={
                h.fiyat != null
                  ? () => setForm((f) => ({ ...f, fiyat: (Math.ceil((h.fiyat ?? 0) * 100) / 100).toFixed(2).replace(".", ",") }))
                  : undefined
              }
              style={[styles.hedef, h.fiyat == null ? { opacity: 0.4 } : null]}
              accessibilityLabel={
                h.fiyat != null ? `Yüzde ${h.marj} marj için ${formatCurrency(h.fiyat)}` : `Yüzde ${h.marj} marj bulunamadı`
              }
            >
              <Txt v="label" tone="accent">
                %{h.marj}
              </Txt>
              <Txt v="smallStrong" num numberOfLines={1} adjustsFontSizeToFit>
                {h.fiyat != null ? formatCurrency(h.fiyat) : "—"}
              </Txt>
            </Tint>
          </FadeInView>
        ))}
      </View>
    </View>
  );
}

/** Fiyatın nereye gittiği: dilimler genişlik değişimiyle akar; zarar kırmızı taşma olarak görünür. */
function FiyatCubugu({ sonuc }: { sonuc: SimulationResult | null }) {
  const azHareket = useReduceMotion();
  const gecis = azHareket ? undefined : LinearTransition.duration(motion.enter);
  const d = sonuc ? fiyatDagilimi(sonuc) : null;
  const toplam = d ? d.dilimler.reduce((a, x) => a + x.tutar, 0) + d.zarar : 0;
  return (
    <View style={{ gap: space.sm }}>
      <View style={styles.cubuk}>
        {d && toplam > 0
          ? d.dilimler
              .filter((x) => x.tutar > 0)
              .map((x) => (
                <Animated.View
                  key={x.anahtar}
                  layout={gecis}
                  style={{ flex: x.tutar / toplam, backgroundColor: DILIM[x.anahtar].renk }}
                />
              ))
          : null}
        {d && toplam > 0 && d.zarar > 0 ? (
          <Animated.View layout={gecis} style={{ flex: d.zarar / toplam, backgroundColor: color.bad }} />
        ) : null}
      </View>
      <View style={styles.lejant}>
        {(Object.keys(DILIM) as (keyof typeof DILIM)[]).map((k) => (
          <View key={k} style={styles.satir}>
            <View style={[styles.noktaKucuk, { backgroundColor: DILIM[k].renk }]} />
            <Txt v="label" tone="faint" style={{ letterSpacing: 0 }}>
              {DILIM[k].ad}
            </Txt>
          </View>
        ))}
      </View>
    </View>
  );
}

function ChipSatiri({
  items,
  selected,
  onSelect,
}: {
  items: { key: string; label: string }[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.chipSatiri}
    >
      {items.map((it) => (
        <Chip key={it.key || "yok"} label={it.label} selected={it.key === selected} onPress={() => onSelect(it.key)} />
      ))}
    </ScrollView>
  );
}

function SayiAlani({
  etiket,
  deger,
  onDegis,
  birim,
  yer,
}: {
  etiket: string;
  deger: string;
  onDegis: (v: string) => void;
  birim?: string;
  yer?: string;
}) {
  return (
    <View style={{ flex: 1, gap: 6 }}>
      <Txt v="label" tone="faint" style={styles.etiket}>
        {etiket.toLocaleUpperCase("tr-TR")}
      </Txt>
      <Input
        value={deger}
        onChangeText={(v) => onDegis(sayiMetni(v))}
        numeric
        placeholder={yer}
        suffix={birim}
        selectTextOnFocus
        accessibilityLabel={etiket.trim() || birim}
      />
    </View>
  );
}

function Etiket({ children }: { children: string }) {
  return (
    <Txt v="label" tone="faint" style={styles.etiket}>
      {children}
    </Txt>
  );
}

function Satir({ renk, ad, tutar }: { renk: string; ad: string; tutar: number }) {
  return (
    <View style={styles.satir}>
      <View style={[styles.nokta, { backgroundColor: renk }]} />
      <Txt v="small" tone="dim" style={{ flex: 1 }} numberOfLines={1}>
        {ad}
      </Txt>
      {/* Eksi tutar kesinti değil alacak (ör. düşük fiyatta KDV iadesi ödenecek KDV'yi aşar). */}
      <Txt v="small" tone={tutar < 0 ? "good" : "dim"} num>
        {tutar < 0 ? "+" : "−"}
        {formatCurrency(Math.abs(tutar))}
      </Txt>
    </View>
  );
}

function Uyari({ children, kirmizi }: { children: string; kirmizi?: boolean }) {
  return (
    <FadeInView style={styles.uyari}>
      <SymbolView
        name="exclamationmark.triangle.fill"
        tintColor={kirmizi ? color.bad : color.warn}
        style={{ width: 14, height: 14, marginTop: 1 }}
      />
      <Txt v="small" tone={kirmizi ? "bad" : "warn"} style={{ flex: 1 }}>
        {children}
      </Txt>
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  icerik: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl, gap: space.md },
  kart: { gap: space.md },
  ikiSutun: { flexDirection: "row", gap: space.sm },
  etiket: { letterSpacing: 1 },
  chipSatiri: { gap: space.sm, paddingRight: space.xs },
  ayrintiBaslik: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 24 },
  maliyet: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  satir: { flexDirection: "row", alignItems: "center", gap: space.sm },
  hedefler: { flexDirection: "row", gap: space.sm },
  hedef: { alignItems: "center", gap: 2, paddingVertical: space.sm, paddingHorizontal: space.xs },
  dokum: { gap: space.sm },
  netSatir: {
    marginTop: space.xs,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  nokta: { width: 8, height: 8, borderRadius: 4 },
  noktaKucuk: { width: 6, height: 6, borderRadius: 3 },
  uyari: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  altCubuk: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    backgroundColor: color.glassStrong,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineStrong,
  },
  altSatir: { flexDirection: "row", alignItems: "flex-end", gap: space.md },
  fiyatAlani: { width: 136, gap: 6 },
  fiyatGirisi: { fontSize: 18 },
  cubuk: {
    flexDirection: "row",
    height: 10,
    borderRadius: radius.pill,
    overflow: "hidden",
    backgroundColor: color.tintStrong,
  },
  lejant: { flexDirection: "row", flexWrap: "wrap", columnGap: space.md, rowGap: space.xs },
});
