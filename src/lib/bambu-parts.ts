/**
 * Bambu'da ŞU AN basılan işin parça listesi (atlama için) — sunucu tarafı.
 *
 * Basılan dosya, yükleme adına gömülü içerik imzasıyla kütüphanedeki kayda eşlenir (kart
 * görseliyle aynı yol: `api/printers/[id]/print-model`). Dosyanın yalnız iki küçük girdisi okunur:
 * bulut dosyasında aralıklı okuma, yerelde tek açma. Sonuç baskı boyunca değişmediği için
 * önbellekte tutulur. Dosya kütüphanede yoksa (ör. Bambu Studio'dan başlatılmış iş) null döner.
 */
import fs from "node:fs";
import { prisma } from "./prisma";
import { getR2Config, getObjectRange } from "./r2";
import { extractContentSignature, matchPrintedModel } from "./print-file-signature";
import { familyMemberIds } from "@/core/printers/printer-family";
import { bambuNesneleriniCoz, type BambuNesneBilgisi } from "@/core/printers/bambu-objects";
import { bambuNesneGirdileri, bambuNesneGirdileriAralikli } from "@/core/printers/model-colors";
import { processSingleton } from "@/core/printers/process-singleton";

const TTL_MS = 6 * 60 * 60_000;
const onbellek = processSingleton("bambuParcaBilgisi", () => new Map<string, { at: number; bilgi: BambuNesneBilgisi | null }>());

const SECIM = { id: true, originalName: true, contentMd5: true, sizeBytes: true, r2Key: true, storedPath: true } as const;

export async function bambuParcaBilgisi(printerId: string, filename: string): Promise<BambuNesneBilgisi | null> {
  const anahtar = `${printerId}|${filename}`;
  const hit = onbellek.get(anahtar);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.bilgi;

  const aile = familyMemberIds(
    await prisma.printerConfig.findMany({ select: { id: true, type: true, brand: true, model: true } }),
    printerId,
  );
  const imza = extractContentSignature(filename);
  const daraltilmis = imza
    ? await prisma.productModelFile.findMany({
        where: { printerConfigId: { in: aile }, contentMd5: { startsWith: imza } },
        select: SECIM,
        take: 50,
      })
    : [];
  let eslesme = daraltilmis.length ? matchPrintedModel(filename, daraltilmis) : null;
  if (!eslesme?.hit) {
    const satirlar = await prisma.productModelFile.findMany({
      where: { printerConfigId: { in: aile }, fileType: "3mf" },
      select: SECIM,
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    eslesme = matchPrintedModel(filename, satirlar);
  }
  const dosya = eslesme?.hit ?? null;

  let bilgi: BambuNesneBilgisi | null = null;
  if (dosya) {
    let girdiler = null;
    if (dosya.r2Key) {
      const cfg = await getR2Config();
      if (cfg) {
        const r2Key = dosya.r2Key;
        girdiler = await bambuNesneGirdileriAralikli((a, b) => getObjectRange(r2Key, cfg, a, b), dosya.sizeBytes);
      }
    } else if (dosya.storedPath && fs.existsSync(dosya.storedPath)) {
      girdiler = bambuNesneGirdileri(await fs.promises.readFile(dosya.storedPath));
    }
    if (girdiler) bilgi = bambuNesneleriniCoz(girdiler.sliceInfo, girdiler.plakaJsonlari);
  }
  onbellek.set(anahtar, { at: Date.now(), bilgi });
  return bilgi;
}
