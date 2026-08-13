import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { swr } from "@/lib/route-cache";

export const dynamic = "force-dynamic";

interface LibFile {
  id: string;
  printerConfigId: string;
  label: string | null;
  originalName: string;
  sizeBytes: number;
  gramaj: number | null;
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
}
interface LibRow {
  productId: string;
  name: string;
  imageUrl: string | null;
  files: LibFile[];
  /** Bu ürünün dosyalarının toplam boyutu (bayt) — listede ve sıralamada kullanılır. */
  totalBytes: number;
}

/**
 * GERÇEKTEN İSRAF EDİLEN DOSYALAR: aynı içerik, FARKLI bulut nesnesi.
 *
 * ⚠️ AYNI NESNEYİ gösteren birden çok satır TEKRAR DEĞİLDİR. "Varyantlara uygula" her varyant
 * ürüne bir satır açar ama dosya bulutta BİR KEZ durur; o satırları tekrar saymak yanlış
 * alarmdır. İlk ölçümüm tam bu hataya düştü: ada göre gruplayıp 14 "tekrar" bulmuştu, oysa
 * hepsi ya geçici (`__custom__`) dosyalardı ya da paylaşılan varyant satırlarıydı.
 *
 * Ölçüldü (13 Ağu 2026): kütüphanede gerçek israf 0 MB. Bu kontrol ileride oluşacak
 * mükerrer YÜKLEMEYİ yakalamak için duruyor.
 *
 * ⚠️ Burada hiçbir şey SİLİNMEZ — yalnız bildirilir.
 */
interface LibDuplicateGroup {
  /** Neye göre eşleşti — arayüz sebebi yazabilsin. */
  reason: "same-content" | "same-name";
  productId: string;
  productName: string;
  printerConfigId: string;
  name: string;
  count: number;
  /** Bir kopya tutulup gerisi silinse kazanılacak alan. */
  wastedBytes: number;
  fileIds: string[];
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
  /** Yazıcı başına: hangi makinenin dosyaları ne kadar yer tutuyor. */
  byPrinter: Array<{ printerConfigId: string; bytes: number; files: number }>;
  /** En büyük dosyalar — temizlik yapılacaksa buradan başlanır. */
  largest: Array<{
    id: string;
    productId: string;
    productName: string;
    printerConfigId: string;
    name: string;
    sizeBytes: number;
  }>;
}

/** Baskı Kütüphanesi: dosyası olan ürünler + yazıcı listesi (kapsama rozetleri için). */
export async function GET() {
  const data = await swr("models:v1", 2 * 60_000, computeModels);
  return NextResponse.json(data);
}

async function computeModels() {
  await ensureRuntimeSchema();
  const [files, printers] = await Promise.all([
    prisma.productModelFile.findMany({
      // "__custom__" = özel baskı dosyaları (ürüne bağlı değil) → kütüphanede gösterme.
      // Bu sentinel'in Product kaydı yoktur → include null döner → eskiden f.product.name patlıyordu.
      where: { NOT: { productId: "__custom__" } },
      include: { product: { select: { id: true, name: true, imageUrl: true } } },
      orderBy: [{ printerConfigId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.printerConfig.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, brand: true, type: true },
    }),
  ]);

  const map = new Map<string, LibRow>();
  for (const f of files) {
    if (!f.product) continue; // ürünü silinmiş yetim dosya → atla (crash guard)
    let row = map.get(f.productId);
    if (!row) {
      row = { productId: f.productId, name: f.product.name, imageUrl: f.product.imageUrl, files: [], totalBytes: 0 };
      map.set(f.productId, row);
    }
    row.files.push({
      id: f.id,
      printerConfigId: f.printerConfigId,
      label: f.label,
      originalName: f.originalName,
      sizeBytes: f.sizeBytes,
      gramaj: f.gramaj,
      fileType: f.fileType,
      hasThumbnail: Boolean(f.thumbnail),
      contentMd5: f.contentMd5 ?? null,
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
  const byPrinter = new Map<string, { bytes: number; files: number }>();
  let uniqueBytes = 0;
  let rowBytes = 0;
  for (const f of files) {
    if (!f.product) continue;
    rowBytes += f.sizeBytes ?? 0;
    const anahtar = f.r2Key ?? `local:${f.id}`;
    if (gorulen.has(anahtar)) continue;
    gorulen.add(anahtar);
    uniqueBytes += f.sizeBytes ?? 0;
    const cur = byPrinter.get(f.printerConfigId) ?? { bytes: 0, files: 0 };
    cur.bytes += f.sizeBytes ?? 0;
    cur.files += 1;
    byPrinter.set(f.printerConfigId, cur);
  }
  const storage: LibStorage = {
    totalBytes: uniqueBytes,
    rowBytes,
    sharedBytes: rowBytes - uniqueBytes,
    fileCount: products.reduce((sum, p) => sum + p.files.length, 0),
    byPrinter: [...byPrinter.entries()]
      .map(([printerConfigId, v]) => ({ printerConfigId, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
    // `.sort()` yerinde sıralar — kopya üzerinde çalış, `files` başka bir yerde kullanılırsa
    // sıralaması sessizce bozulmasın.
    largest: [...files]
      // Aynı nesneyi gösteren satırlar listede TEKRAR ETMESİN (varyantlar aynı dosyayı paylaşır).
      .filter((f, i, arr) => f.product && arr.findIndex((o) => (o.r2Key ?? o.id) === (f.r2Key ?? f.id)) === i)
      .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
      .slice(0, 10)
      .map((f) => ({
        id: f.id,
        productId: f.productId,
        productName: f.product!.name,
        printerConfigId: f.printerConfigId,
        name: f.label || f.originalName,
        sizeBytes: f.sizeBytes ?? 0,
      })),
  };

  return { products, printers, storage, duplicates: findDuplicates(files) };
}

type FileRow = {
  id: string;
  productId: string;
  printerConfigId: string;
  label: string | null;
  originalName: string;
  sizeBytes: number;
  contentMd5: string | null;
  r2Key: string | null;
  product: { name: string } | null;
};

/**
 * Tekrar eden dosyaları bul. İçerik imzası ADA GÖRE önceliklidir: aynı içerik farklı adla
 * yüklenmişse ada bakan kontrol onu kaçırır, tersi doğru değildir.
 */
function findDuplicates(files: FileRow[]): LibDuplicateGroup[] {
  const groups = new Map<string, { reason: LibDuplicateGroup["reason"]; rows: FileRow[] }>();

  for (const f of files) {
    if (!f.product) continue;
    // Aynı içerik: ürün fark etmeksizin AYNI dosyadır; yine de ürün+yazıcı kırılımında
    // gösteriyoruz ki kullanıcı hangi kaydı sileceğini bilsin.
    // ⚠️ AYNI NESNEYİ gösteren satırlar TEKRAR DEĞİLDİR — "varyantlara uygula" bilerek böyle
    // yapıyor ve dosya bulutta bir kez duruyor. Gerçek israf: AYNI İÇERİK, FARKLI nesne.
    if (!f.contentMd5 || !f.r2Key) continue;
    const key = `md5|${f.contentMd5}`;
    const reason: LibDuplicateGroup["reason"] = "same-content";
    const cur = groups.get(key) ?? { reason, rows: [] };
    cur.rows.push(f);
    groups.set(key, cur);
  }

  const out: LibDuplicateGroup[] = [];
  for (const { reason, rows } of groups.values()) {
    // Kaç AYRI bulut nesnesi var? Bir taneyse israf yok, yalnız paylaşılan satırlar var.
    const nesneler = new Set(rows.map((r) => r.r2Key));
    if (nesneler.size < 2) continue;
    const first = rows[0];
    // Bir kopya KALIR: israf = toplam − en büyüğü (en büyüğü tutmak en kötü durumu ölçer).
    const biggest = Math.max(...rows.map((r) => r.sizeBytes ?? 0));
    // Fazladan duran her NESNE israftır (satır değil).
    const wastedBytes = biggest * (nesneler.size - 1);
    out.push({
      reason,
      productId: first.productId,
      productName: first.product!.name,
      printerConfigId: first.printerConfigId,
      name: first.label || first.originalName,
      count: nesneler.size,
      wastedBytes,
      fileIds: rows.map((r) => r.id),
    });
  }
  return out.sort((a, b) => b.wastedBytes - a.wastedBytes);
}
