import fs from "node:fs/promises";
import path from "node:path";
import { getUserDataDir } from "@/lib/storage";
import type { HepsijetClient, HepsijetOrtami, HepsijetYer } from "@/services/hepsijet-client";

/**
 * HEPSIJET İL / İLÇE / MAHALLE LİSTELERİ — önbellekli.
 *
 * Adres ayrıştırıcı (`adres-coz`) il ve ilçe adlarını HepsiJet'in yazdığı gibi ister. Tam liste
 * 81 il + il başına bir ilçe isteği demek → yerel dosyada 7 gün saklanır (listeler nadiren
 * değişir). Mahalleler ilçe seçilince tek istekle alınır, bellekte 1 gün tutulur.
 */

export interface HepsijetIl {
  id: number;
  ad: string;
  ilceler: HepsijetYer[];
}

interface Onbellek {
  ortam: HepsijetOrtami;
  alindi: number;
  iller: HepsijetIl[];
}

const DOSYA = "hepsijet-yerler.json";
const OMUR_MS = 7 * 24 * 60 * 60_000;
const MAHALLE_OMRU_MS = 24 * 60 * 60_000;
const ESZAMANLI = 8;

const g = globalThis as unknown as {
  __HJ_YERLER__?: Onbellek;
  __HJ_YERLER_SURUYOR__?: Promise<HepsijetIl[]>;
  __HJ_MAHALLELER__?: Map<string, { alindi: number; liste: string[] }>;
};

function dosyaYolu() {
  return path.join(getUserDataDir(), DOSYA);
}

async function dosyadanOku(ortam: HepsijetOrtami): Promise<Onbellek | null> {
  try {
    const j = JSON.parse(await fs.readFile(dosyaYolu(), "utf8")) as Onbellek;
    if (j?.ortam !== ortam || !Array.isArray(j.iller) || j.iller.length < 70) return null;
    return j;
  } catch {
    return null;
  }
}

/** Tüm iller ve ilçeleri (HepsiJet adlarıyla). */
export async function hepsijetIlleri(hj: HepsijetClient, ortam: HepsijetOrtami): Promise<HepsijetIl[]> {
  const bellek = g.__HJ_YERLER__;
  if (bellek && bellek.ortam === ortam && Date.now() - bellek.alindi < OMUR_MS) return bellek.iller;
  const dosya = await dosyadanOku(ortam);
  if (dosya && Date.now() - dosya.alindi < OMUR_MS) {
    g.__HJ_YERLER__ = dosya;
    return dosya.iller;
  }
  if (g.__HJ_YERLER_SURUYOR__) return g.__HJ_YERLER_SURUYOR__;
  const is = (async () => {
    try {
      const iller = await hj.iller();
      const sonuc: HepsijetIl[] = [];
      for (let i = 0; i < iller.length; i += ESZAMANLI) {
        const dilim = iller.slice(i, i + ESZAMANLI);
        const ilceler = await Promise.all(dilim.map((il) => hj.ilceler(il.id)));
        dilim.forEach((il, k) => sonuc.push({ id: il.id, ad: il.ad, ilceler: ilceler[k] }));
      }
      const yeni: Onbellek = { ortam, alindi: Date.now(), iller: sonuc };
      g.__HJ_YERLER__ = yeni;
      await fs.mkdir(path.dirname(dosyaYolu()), { recursive: true }).catch(() => {});
      await fs.writeFile(dosyaYolu(), JSON.stringify(yeni), "utf8").catch(() => {});
      return sonuc;
    } catch (hata) {
      // Ağ hatasında eski (süresi geçmiş) dosya varsa onunla devam et.
      if (dosya) return dosya.iller;
      throw hata;
    } finally {
      g.__HJ_YERLER_SURUYOR__ = undefined;
    }
  })();
  g.__HJ_YERLER_SURUYOR__ = is;
  return is;
}

const sade = (s: string) => s.toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim();

/** İlçenin mahalleleri (ad listesi). İl/ilçe adı HepsiJet listesindeki gibi verilir. */
export async function hepsijetMahalleleri(
  hj: HepsijetClient,
  ortam: HepsijetOrtami,
  ilAdi: string,
  ilceAdi: string
): Promise<string[]> {
  const iller = await hepsijetIlleri(hj, ortam);
  const il = iller.find((x) => sade(x.ad) === sade(ilAdi));
  const ilce = il?.ilceler.find((x) => sade(x.ad) === sade(ilceAdi));
  if (!ilce) return [];
  const harita = (g.__HJ_MAHALLELER__ ??= new Map());
  const anahtar = `${ortam}:${ilce.id}`;
  const kayit = harita.get(anahtar);
  if (kayit && Date.now() - kayit.alindi < MAHALLE_OMRU_MS) return kayit.liste;
  const liste = (await hj.mahalleler(ilce.id)).map((m) => m.ad).sort((a, b) => a.localeCompare(b, "tr"));
  harita.set(anahtar, { alindi: Date.now(), liste });
  return liste;
}
