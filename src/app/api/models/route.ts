import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { swr } from "@/lib/route-cache";
import { renkleriCoz } from "@/lib/model-dosya-gorunum";
import { gorselliKimlikler } from "@/lib/model-gorseli";

export const dynamic = "force-dynamic";

interface LibFile {
  id: string;
  printerConfigId: string;
  label: string | null;
  originalName: string;
  sizeBytes: number;
  gramaj: number | null;
  /** Dilimleyicinin tahmini baskı süresi (dk) — YALNIZ gösterim, ürün maliyetiyle ilgisi yok. */
  estPrintMin: number | null;
  fileType: string;
  /**
   * Kayıtlı önizleme görselinin KENDİSİ değil, VAR MI bilgisi.
   *
   * ⚠️ Görseller data-URL olarak saklanıyor ve ortalama 61 KB. Kütüphanedeki 470 dosyanın
   * 122'sinde görsel var; hepsini bu yanıta gömmek listeyi 12,5 MB büyütürdü. Görsel
   * `/api/models/<id>/preview` ucundan tek tek, uzun önbellekle çekilir.
   */
  hasThumbnail: boolean;
  /** `vizKeyForModel` bunu kullanıyor — aynı içerik farklı kayıtlarda tek önbelleğe düşsün. */
  contentMd5: string | null;
  /** Kullanılan filament renkleri (#RRGGBB) — parça satırında nokta olarak çizilir. */
  renkler: string[];
  /**
   * Bu dosyayı KAÇ kayıt paylaşıyor (aynı bulut nesnesi).
   *
   * "Varyantlara uygula" aynı dosyayı birden çok ürüne bağlar; bulutta tek nesne durur.
   * Silme onayı bunu SÖYLEMELİ — kullanıcı bir üründen silerken diğerlerinden de kalktığını
   * bilmezse sessiz veri kaybı olur. Ölçüldü: 2,81 GB böyle paylaşılıyor.
   */
  sharedWith: number;
}
interface LibRow {
  productId: string;
  name: string;
  imageUrl: string | null;
  files: LibFile[];
  /** Bu ürünün dosyalarının toplam boyutu (bayt) — listede ve sıralamada kullanılır. */
  totalBytes: number;
  /** Varyant grubu — aynı gruptaki ürünler kütüphanede TEK satırda toplanır. */
  variantGroupId: string | null;
  variantGroupName: string | null;
}

/**
 * Kütüphanenin yer kaplaması — hiçbir ekranda yazmıyordu, sessizce büyüyordu.
 *
 * ⚠️ SATIRLARIN TOPLAMI GERÇEK KULLANIM DEĞİLDİR. "Varyantlara uygula" aynı dosya için her
 * varyant ürüne bir satır açar ama dosya bulutta BİR KEZ durur (satırlar aynı `r2Key`'i
 * gösterir). Ölçüldü (13 Ağu 2026): satır toplamı 8,39 GB, benzersiz nesne toplamı 5,59 GB —
 * yani satırları toplamak 2,81 GB fazla gösteriyordu. `totalBytes` BENZERSİZ nesneleri sayar.
 */
interface LibStorage {
  /** Buluttaki GERÇEK kullanım — aynı nesneyi gösteren satırlar bir kez sayılır. */
  totalBytes: number;
  /** Satırların toplamı — ürün satırlarındaki boyutlar buna toplanır. */
  rowBytes: number;
  /** Varyantlar arasında paylaşıldığı için bir kez sayılan alan (`rowBytes − totalBytes`). */
  sharedBytes: number;
  fileCount: number;
}

/**
 * Baskı Kütüphanesi: TÜM görünür ürünler (dosyası olsun olmasın) + yazıcı listesi.
 *
 * Eskiden yalnız dosyası OLAN ürünler dönüyordu; sayfanın asıl sorusu ise "hangisinin dosyası
 * yok". Ölçüldü (13 Eki 2026): 481 görünür ürünün 328'inin hiç dosyası yoktu ve hiçbiri
 * listede görünmüyordu.
 */
export async function GET() {
  // Sürüm, yanıt biçimi her değiştiğinde artar — diskteki eski gövde okunmasın.
  // v2: dosyasız ürünler + varyant grubu · v3: parça renkleri.
  // v4: kullanılmayan alanlar (kopyalar / en büyükler / yazıcı kırılımı) çıktı, kapalı yazıcı adları geldi.
  // bayatSiniriMs: diskteki ESKİ gövde (başka cihazda yapılan değişiklikten önceki) en çok 10 dk
  // anında verilir; daha eskiyse taze hesap beklenir (denetim, 23 Kas 2026).
  const data = await swr("models:v4", 2 * 60_000, computeModels, { bayatSiniriMs: 10 * 60_000 });
  return NextResponse.json(data);
}

async function computeModels() {
  await ensureRuntimeSchema();
  const [files, printers, urunler, kapaliYazicilar] = await Promise.all([
    prisma.productModelFile.findMany({
      // "__custom__" = özel baskı dosyaları (ürüne bağlı değil) → kütüphanede gösterme.
      // Bu sentinel'in Product kaydı yoktur → include null döner → eskiden f.product.name patlıyordu.
      where: { NOT: { productId: "__custom__" } },
      // KOLONLAR TEK TEK. `include` bütün tabloyu satır satır çekiyordu; `thumbnail` kolonunda
      // gömülü önizleme görselleri var. ÖLÇÜLDÜ (14 Ağu 2026): 694 satır = 19,76 MB thumbnail,
      // ve bu rota 2 dakikada bir tazeleniyor → uzak veritabanından sürekli 20 MB çekiliyordu.
      // Aşağıda `thumbnail`ın yalnız VAR/YOK bilgisi kullanılıyor; onu ayrı ve ucuz bir sorgu
      // veriyor (thumbIds). Yeni alan eklersen BURAYA da ekle.
      select: {
        id: true, productId: true, printerConfigId: true, label: true,
        originalName: true, sizeBytes: true, gramaj: true, estPrintMin: true,
        fileType: true, contentMd5: true, r2Key: true,
        colorsJson: true, // küçük (birkaç yüz bayt); ekrana yalnız çizilecek renkler gider
      },
      orderBy: [{ printerConfigId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.printerConfig.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      // model: aile hesabı (aynı marka + model yazıcılar dosyaları paylaşır) bunu kullanıyor.
      select: { id: true, name: true, brand: true, type: true, model: true },
    }),
    // Ürünler AYRI sorguda: dosyası olmayanlar da listelenecek. Yalnız çizilen alanlar.
    prisma.product.findMany({
      select: {
        id: true, name: true, imageUrl: true, hidden: true, variantGroupId: true,
        variantGroup: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    }),
    // Kapalı yazıcıların ADI — o yazıcılara ait (görünmeyen) dosyalar "sahipsiz" listesinde adıyla yazsın.
    prisma.printerConfig.findMany({ where: { enabled: false }, select: { id: true, name: true } }),
  ]);
  const urunById = new Map(urunler.map((u) => [u.id, u]));

  // Hangi dosyada gömülü önizleme VAR — yalnız kimlikler (görsel kendi tablosunda, PK dizininden
  // okunur; bkz. lib/model-gorseli.ts).
  const thumbIds = await gorselliKimlikler();

  // Aynı bulut nesnesini kaç kayıt gösteriyor — silme onayı bunu söyleyecek.
  const paylasim = new Map<string, number>();
  for (const f of files) {
    if (f.r2Key) paylasim.set(f.r2Key, (paylasim.get(f.r2Key) ?? 0) + 1);
  }

  const map = new Map<string, LibRow>();
  const satirAc = (u: (typeof urunler)[number]): LibRow => {
    const row: LibRow = {
      productId: u.id, name: u.name, imageUrl: u.imageUrl, files: [], totalBytes: 0,
      variantGroupId: u.variantGroupId ?? null,
      variantGroupName: u.variantGroup?.name ?? null,
    };
    map.set(u.id, row);
    return row;
  };
  // Gizlenen ürün listelenmez — AMA dosyası varsa görünür kalır (aşağıda eklenir): yoksa o
  // dosyalar hiçbir ekrandan silinemez ve bulutta sessizce yer tutardı.
  for (const u of urunler) if (!u.hidden) satirAc(u);
  for (const f of files) {
    const urun = urunById.get(f.productId);
    if (!urun) continue; // ürünü silinmiş yetim dosya → atla (crash guard)
    const row = map.get(f.productId) ?? satirAc(urun);
    row.files.push({
      id: f.id,
      printerConfigId: f.printerConfigId,
      label: f.label,
      originalName: f.originalName,
      sizeBytes: f.sizeBytes,
      gramaj: f.gramaj,
      estPrintMin: f.estPrintMin,
      fileType: f.fileType,
      hasThumbnail: thumbIds.has(f.id),
      contentMd5: f.contentMd5 ?? null,
      renkler: renkleriCoz(f.colorsJson),
      sharedWith: f.r2Key ? (paylasim.get(f.r2Key) ?? 1) : 1,
    });
    row.totalBytes += f.sizeBytes ?? 0;
  }

  const products = [...map.values()];

  // ── Depolama özeti ────────────────────────────────────────────────────────────────
  // Ölçüldü (13 Ağu 2026): 470 kütüphane dosyası, 8,6 GB. Bu sayı hiçbir ekranda
  // yazmıyordu; kullanıcı ancak fatura ya da kota ile fark ederdi.
  // Aynı bulut nesnesi (r2Key) BİR KEZ sayılır. `r2Key` yoksa (yalnız yerelde duran dosya)
  // satırın kendisi benzersiz kabul edilir.
  const gorulen = new Set<string>();
  let uniqueBytes = 0;
  let rowBytes = 0;
  for (const f of files) {
    if (!urunById.has(f.productId)) continue;
    rowBytes += f.sizeBytes ?? 0;
    const anahtar = f.r2Key ?? `local:${f.id}`;
    if (gorulen.has(anahtar)) continue;
    gorulen.add(anahtar);
    uniqueBytes += f.sizeBytes ?? 0;
  }
  const storage: LibStorage = {
    totalBytes: uniqueBytes,
    rowBytes,
    sharedBytes: rowBytes - uniqueBytes,
    fileCount: products.reduce((sum, p) => sum + p.files.length, 0),
  };

  return { products, printers, storage, kapaliYazicilar };
}


