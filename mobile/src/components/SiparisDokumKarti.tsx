import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { Pill } from "@/components/kit/Chip";
import { Bolum, Button, Count, FadeInView, Input, Money, Txt, type TxtTone } from "@/components/kit";
import { kargoDesisiKaydet } from "@/lib/db/kargo-desi";
import { formatCurrency } from "@/lib/format";
import { kargoDesiOku } from "@core/kargo-desi";
import type { OrderProfit, SiparisDokumu } from "@/lib/order-profit";
import { color, space } from "@/theme/tokens";

/**
 * SİPARİŞ KÂR DÖKÜMÜ — masaüstü Siparişler satırındaki "Kargo & Kâr" kutusunun telefondaki karşılığı:
 * komisyon, ürün + paketleme, kargo, pazaryeri bedelleri, cezalar, reklam payı; iade edilen
 * siparişte iade zararının kalemleri. Rakamlar AYNI çekirdek hesabından gelir (`order-profit`).
 */
export function SiparisDokumKarti({
  profit,
  iptal,
  baslangic = 0,
  siparis,
}: {
  profit: OrderProfit;
  iptal: boolean;
  baslangic?: number;
  /** Shopify siparişinde kargo desisi buradan düzeltilebilir. */
  siparis?: { platform: string; id: string };
}) {
  const d = profit.dokum;
  if (!d) return null;
  if (iptal) return d.iade ? <IadeDokumu d={d} baslangic={baslangic} /> : null;
  if (profit.profit == null) return null;

  const satirlar: React.ReactNode[] = [];
  let sira = 0;
  const ekle = (anahtar: string, dugum: React.ReactNode) =>
    satirlar.push(
      <FadeInView key={anahtar} index={baslangic + sira++} step={45}>
        {dugum}
      </FadeInView>
    );

  // Komisyon — pazaryeri gerçek tutarı bildirdiyse o, tahminden farkıyla.
  const fark = d.komisyonKaynagi === "gercek" && Math.abs(d.komisyon - d.komisyonTahmini) >= 0.01 ? d.komisyon - d.komisyonTahmini : null;
  const oranMetni = d.komisyonOranlari
    .slice(0, 3)
    .map((o) => `%${(o * 100).toLocaleString("tr-TR", { maximumFractionDigits: 2 })}`)
    .join(" · ");
  ekle(
    "komisyon",
    <Satir
      ad="Komisyon"
      rozet={
        d.komisyonKaynagi === "gercek" ? (
          <Pill color={color.good}>gerçek</Pill>
        ) : d.komisyonKaynagi === "siparis" && !d.komisyonEksik ? (
          <Pill color={color.info}>{`siparişte kesilen${oranMetni ? ` ${oranMetni}` : ""}`}</Pill>
        ) : (
          <Txt v="small" tone="faint">
            {d.komisyonEksik ? "tahmini · eksik" : "tahmini"}
          </Txt>
        )
      }
      tutar={d.komisyon}
      alt={
        d.komisyonEksik
          ? "yalnız maliyeti bilinen ürünler için"
          : fark != null
            ? `tahmin ${formatCurrency(d.komisyonTahmini)} · ${fark > 0 ? "+" : "−"}${formatCurrency(Math.abs(fark))}`
            : undefined
      }
    />
  );
  if (d.urunVePaketleme > 0) ekle("urun", <Satir ad="Ürün + paketleme" tutar={d.urunVePaketleme} />);
  if (d.kargo > 0) {
    ekle(
      "kargo",
      <Satir
        ad="Kargo"
        rozet={d.kargoGercek ? <Pill color={color.good}>gerçek</Pill> : null}
        tutar={d.kargo}
        // Kaç desiden hesaplandığı her zaman yazar ("~" = desi tahmini).
        alt={d.kargoEtiketi ?? undefined}
        altSolda
      />
    );
  }
  if (d.fazlaDesi) {
    ekle(
      "fazla-desi",
      <Satir
        ad={`Fazla desi · ${d.fazlaDesi.bizimDesi} yerine ${d.fazlaDesi.kesilenDesi} desi`}
        adTon="info"
        tutar={d.fazlaDesi.fazla}
        isaret="+"
        ton="bad"
      />
    );
  }
  if (d.gecikmeBedeli > 0) {
    ekle("gecikme", <Satir ad="Gecikme bedeli" rozet={<Kaynak gercek={d.gecikmeGercek} />} tutar={d.gecikmeBedeli} ton="bad" />);
  }
  if (d.kusurluBedeli > 0) {
    ekle("kusurlu", <Satir ad="Kusurlu ürün bedeli" rozet={<Kaynak gercek={d.kusurluGercek} />} tutar={d.kusurluBedeli} ton="bad" />);
  }
  if (d.gecikmeKesilmedi) ekle("gecikme-yok", <Not metin="Geç kargolandı · bedel kesilmedi." />);
  if (d.hizmetBedeli > 0) {
    ekle("hizmet", <Satir ad="Hizmet bedeli" rozet={d.hizmetGercek ? <Pill color={color.good}>gerçek</Pill> : null} tutar={d.hizmetBedeli} />);
  }
  if (d.tahsilatBedeli > 0) {
    ekle("tahsilat", <Satir ad={siparis?.platform === "n11" ? "Pazarlama ve hizmet bedeli" : "Tahsilat bedeli"} rozet={d.tahsilatGercek ? <Pill color={color.good}>gerçek</Pill> : null} tutar={d.tahsilatBedeli} />);
  }
  if (d.uluslararasiBedel > 0) ekle("uluslararasi", <Satir ad="Uluslararası hizmet bedeli" tutar={d.uluslararasiBedel} />);
  if (d.kargoKuralYok) ekle("kargo-yok", <Not metin="Kargo kuralı yok — kargo 0 sayıldı." vurgu />);
  // Shopify: kargoyu gerçekte kaç desiyle çıkardıysan düzelt (masaüstündeki "Desi" ile aynı kayıt).
  if (siparis?.platform === "shopify" && !d.kargoGercek) {
    ekle("kargo-desi", <KargoDesiDuzenleyici siparisId={siparis.id} desi={d.kargoDesi} elle={d.kargoDesiElle} />);
  }
  if (d.reklamPayi > 0) ekle("reklam", <Satir ad="Reklam payı" tutar={d.reklamPayi} />);
  if (Math.abs(d.kargoGeliri) >= 0.01) {
    ekle(
      "kargo-geliri",
      <Satir ad="Kargo geliri / sipariş indirimi" tutar={Math.abs(d.kargoGeliri)} isaret={d.kargoGeliri >= 0 ? "+" : "−"} ton={d.kargoGeliri >= 0 ? "good" : "dim"} />
    );
  }
  if (d.stopaj > 0) {
    ekle("stopaj", <Satir ad="Stopaj" rozet={<Txt v="small" tone="faint">kâra girmez</Txt>} tutar={d.stopaj} isaret="" ton="faint" />);
  }

  return (
    <Bolum title="Kâr dökümü" desc="Kalem kalem kesintiler" icon="list.bullet.rectangle.portrait.fill">
      <View style={styles.kart}>
      {satirlar}
      <View style={styles.cizgi} />
      <FadeInView index={baslangic + sira} step={45}>
        <View style={styles.satir}>
          <Txt v="bodyStrong">Net kâr</Txt>
          <View style={styles.toplam}>
            {profit.partial ? (
              <Txt v="bodyStrong" tone="dim">
                ~
              </Txt>
            ) : null}
            <Money value={profit.profit} v="bodyStrong" tone={profit.profit < 0 ? "bad" : "good"} />
          </View>
        </View>
      </FadeInView>
      </View>
    </Bolum>
  );
}

/**
 * SHOPIFY KARGO DESİSİ — "Desiyi düzelt": sipariş gerçekte kaç desiyle çıktıysa yazılır, kargo bedeli
 * ürün desilerinin toplamı yerine bununla hesaplanır (masaüstüyle aynı kayıt).
 */
function KargoDesiDuzenleyici({ siparisId, desi, elle }: { siparisId: string; desi: number | null; elle: boolean }) {
  const qc = useQueryClient();
  const [acik, setAcik] = useState(false);
  const [metin, setMetin] = useState("");
  const gecerli = kargoDesiOku(metin);
  const kaydet = useMutation({
    mutationFn: (yeni: number | null) => kargoDesisiKaydet(siparisId, yeni),
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Elle girilen desiler kurallarla birlikte okunuyor → kâr ve döküm yeni desiyle yeniden hesaplanır.
      void qc.invalidateQueries({ queryKey: ["rules"] });
      setAcik(false);
    },
    onError: (e: Error) => Alert.alert("Kaydedilemedi", e.message || "Bağlantını kontrol edip tekrar dene."),
  });

  if (!acik) {
    return (
      <View style={styles.satir}>
        <Txt v="small" tone={elle ? "accent" : "faint"} style={{ flexShrink: 1 }}>
          {elle ? "Kargo desisini sen girdin" : "Paket farklı desiyle mi çıktı?"}
        </Txt>
        <Button
          label="Desiyi düzelt"
          icon="pencil"
          size="sm"
          variant="secondary"
          onPress={() => {
            setMetin(desi != null ? String(desi).replace(".", ",") : "");
            setAcik(true);
          }}
        />
      </View>
    );
  }
  return (
    <FadeInView index={0} step={0}>
      <View style={styles.duzenleyici}>
        <Input
          value={metin}
          onChangeText={setMetin}
          numeric
          suffix="desi"
          placeholder={desi != null ? String(desi) : "4"}
          autoFocus
          style={{ flex: 1 }}
        />
        <Button label="Kaydet" size="sm" disabled={gecerli == null} loading={kaydet.isPending} onPress={() => gecerli != null && kaydet.mutate(gecerli)} />
      </View>
      <View style={[styles.satir, { marginTop: space.xs }]}>
        {elle ? (
          <Button label="Ürün desisine dön" icon="arrow.uturn.backward" size="sm" variant="secondary" disabled={kaydet.isPending} onPress={() => kaydet.mutate(null)} />
        ) : (
          <View />
        )}
        <Button label="Vazgeç" size="sm" variant="secondary" disabled={kaydet.isPending} onPress={() => setAcik(false)} />
      </View>
    </FadeInView>
  );
}

/** Kargolanıp geri gelen sipariş: satış ve komisyon iade edildi; iki yön kargo + hizmet bedeli kaldı. */
function IadeDokumu({ d, baslangic }: { d: SiparisDokumu; baslangic: number }) {
  const z = d.iade!;
  const kalemler = [
    { ad: "Gidiş kargosu", tutar: z.outboundCargo, gercek: z.outboundActual },
    { ad: "Dönüş kargosu", tutar: z.returnCargo, gercek: z.returnActual },
    { ad: "Hizmet bedeli", tutar: z.serviceFee, gercek: z.serviceFeeActual },
    { ad: "Gecikme bedeli", tutar: Math.max(0, z.penalty - d.kusurluBedeli), gercek: d.gecikmeGercek },
    { ad: "Kusurlu ürün bedeli", tutar: d.kusurluBedeli, gercek: d.kusurluGercek },
  ].filter((k) => k.tutar > 0);
  return (
    <Bolum title="İade zararı" desc="İadenin kâra etkisi" icon="arrow.uturn.backward.circle.fill">
      <View style={styles.kart}>
      {kalemler.map((k, i) => (
        <FadeInView key={k.ad} index={baslangic + i} step={45}>
          <Satir ad={k.ad} rozet={<Kaynak gercek={k.gercek} />} tutar={k.tutar} />
        </FadeInView>
      ))}
      {z.inputVatCredit > 0 ? (
        <FadeInView index={baslangic + kalemler.length} step={45}>
          <Satir ad="KDV indirimi" tutar={z.inputVatCredit} isaret="+" ton="good" />
        </FadeInView>
      ) : null}
      {z.cargoRuleMissing ? <Not metin="Gidiş kargosu için kural yok — zarar eksik olabilir." vurgu /> : null}
      <View style={styles.cizgi} />
      <View style={styles.satir}>
        <Txt v="bodyStrong">İade zararı</Txt>
        <Count value={z.loss} v="bodyStrong" tone="bad" format={(n) => `−${formatCurrency(n)}`} />
      </View>
      <Not metin="Satış tutarı ve komisyon iade edildi." />
      </View>
    </Bolum>
  );
}

function Satir({
  ad,
  adTon = "dim",
  rozet,
  tutar,
  isaret = "−",
  ton = "default",
  alt,
  altSolda = false,
}: {
  ad: string;
  adTon?: TxtTone;
  rozet?: React.ReactNode;
  tutar: number;
  isaret?: "−" | "+" | "";
  ton?: TxtTone;
  alt?: string;
  /** Açıklama satırı solda (kalemin altında) — tutar farkı gibi notlar sağda kalır. */
  altSolda?: boolean;
}) {
  return (
    <View style={styles.satirKutu}>
      <View style={styles.satir}>
        <View style={styles.sol}>
          <Txt v="small" tone={adTon} numberOfLines={1} style={{ flexShrink: 1 }}>
            {ad}
          </Txt>
          {rozet}
        </View>
        <Count value={tutar} v="smallStrong" tone={ton} format={(n) => `${isaret}${formatCurrency(n)}`} />
      </View>
      {alt ? (
        <Txt v="small" tone="faint" style={altSolda ? undefined : styles.alt} num numberOfLines={1}>
          {alt}
        </Txt>
      ) : null}
    </View>
  );
}

/** Pazaryerinin faturasıyla kesinleşen kalem "gerçek", gerisi "tahmini". */
function Kaynak({ gercek }: { gercek: boolean }) {
  return gercek ? (
    <Pill color={color.good}>gerçek</Pill>
  ) : (
    <Txt v="small" tone="faint">
      tahmini
    </Txt>
  );
}

function Not({ metin, vurgu = false }: { metin: string; vurgu?: boolean }) {
  return (
    <Txt v="small" style={{ color: vurgu ? color.info : color.textFaint }}>
      {metin}
    </Txt>
  );
}

const styles = StyleSheet.create({
  kart: { gap: space.sm },
  kicker: { letterSpacing: 1, marginBottom: 2 },
  satirKutu: { gap: 2 },
  satir: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  sol: { flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 1 },
  alt: { textAlign: "right" },
  toplam: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  cizgi: { height: StyleSheet.hairlineWidth, backgroundColor: color.line, marginVertical: 2 },
  duzenleyici: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
