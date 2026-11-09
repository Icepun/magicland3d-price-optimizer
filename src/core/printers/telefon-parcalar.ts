/**
 * TELEFONA PARÇA LİSTESİ — "bozulan parçayı telefondan iptal et" için yazıcı anlık görüntüsüne
 * (PrinterSnapshot.detail) eklenen parça bilgisi.
 *
 * Telefon yazıcıya ulaşamaz; masaüstü parçaları yazar, telefon numarayla seçip komut gönderir,
 * masaüstü uygular (relay `exclude`). Numaralar masaüstü seçicisinin AYNI kuralıyla
 * (`parcalariSirala`: ön→arka, sol→sağ) burada verilir → iki ekran aynı numarayı söyler.
 *
 * Maliyet: parça listesi baskı boyunca değişmez.
 *   • U1: yazıcıdan İŞ BAŞINA bir kez okunur (poligonlu yanıt ~3,8 KB; 10 sn'lik turda her
 *     seferinde istenmez). Liste boş geldiyse (dosyanın başı henüz okunmadı) bir dakika sonra yine denenir.
 *   • Bambu: basılan 3MF'ten (lib/bambu-parts — zaten 6 saat önbellekli).
 * Anlık görüntüye yalnız kutular yazılır (poligon değil) — satır baskı boyunca sık yazılıyor.
 */
import { processSingleton } from "./process-singleton";
import { fetchMoonrakerObjects } from "./moonraker";
import { bambuAtlananlar } from "./bambu";
import { bambuNesnePoligonlari } from "./bambu-objects";
import { bambuParcaBilgisi } from "@/lib/bambu-parts";
import { parcalariSirala, type PartPolygon } from "@/app/printers/part-map";
import type { YaziciParca } from "../printer-detail";

const ONBELLEK_MS = 30 * 60_000;
const BOS_TEKRAR_MS = 60_000;

const onbellek = processSingleton(
  "telefonParcalari",
  () => new Map<string, { at: number; parcalar: YaziciParca[] }>(),
);

const yuvarla = (n: number) => Math.round(n * 10) / 10;

/** Poligonlu parça listesi → numaralı kutular. 2'den az parça varsa iptal anlamsız → boş. */
export function telefonParcalari(ham: PartPolygon[]): YaziciParca[] {
  const sirali = parcalariSirala(ham);
  if (sirali.length < 2) return [];
  return sirali.map((p) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p.polygon) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return { ad: p.name, no: p.no, kutu: [yuvarla(x0), yuvarla(y0), yuvarla(x1), yuvarla(y1)] };
  });
}

async function onbellekli(anahtar: string, getir: () => Promise<YaziciParca[]>): Promise<YaziciParca[]> {
  const hit = onbellek.get(anahtar);
  const sure = hit && hit.parcalar.length ? ONBELLEK_MS : BOS_TEKRAR_MS;
  if (hit && Date.now() - hit.at < sure) return hit.parcalar;
  let parcalar: YaziciParca[] = [];
  try { parcalar = await getir(); } catch { /* okunamadı — boş, kısa süre sonra yine denenir */ }
  onbellek.set(anahtar, { at: Date.now(), parcalar });
  // Bitmiş işlerin kayıtları birikmesin.
  if (onbellek.size > 40) {
    const enEski = [...onbellek.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (enEski) onbellek.delete(enEski);
  }
  return parcalar;
}

export async function moonrakerTelefonParcalari(
  printerId: string, host: string, port: number, filename: string, iptaller: string[],
): Promise<{ parcalar: YaziciParca[]; iptalParcalar: string[] }> {
  const parcalar = await onbellekli(`${printerId}|${filename}`, async () =>
    telefonParcalari(await fetchMoonrakerObjects(host, port)),
  );
  return { parcalar, iptalParcalar: parcalar.length ? iptaller : [] };
}

export async function bambuTelefonParcalari(
  printerId: string, host: string, accessCode: string, serial: string, filename: string,
): Promise<{ parcalar: YaziciParca[]; iptalParcalar: string[] }> {
  const parcalar = await onbellekli(`${printerId}|${filename}`, async () => {
    const bilgi = await bambuParcaBilgisi(printerId, filename);
    return bilgi?.etiketli ? telefonParcalari(bambuNesnePoligonlari(bilgi.nesneler)) : [];
  });
  return {
    parcalar,
    iptalParcalar: parcalar.length ? bambuAtlananlar(host, accessCode, serial).map(String) : [],
  };
}
