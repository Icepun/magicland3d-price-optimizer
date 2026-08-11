import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

/**
 * Bir makaranın tüketim geçmişi (sayfalanmış).
 *
 * NEDEN tek sorgu: uzak-HTTP libSQL modunda her sorgu ~96ms ve TÜM sorgular süreç genelinde
 * sıralı. Bu uç bir kart açıldığında çağrılıyor; ikinci bir sorgu (örn. makarayı yeniden okumak)
 * doğrudan gecikmeyi ikiye katlardı. Bu yüzden kalan gram İSTEMCİDE zaten var kabul edilir ve
 * burada yalnız "günlük tüketim hızı" üretilir; "kaç gün sonra biter" çarpımını istemci yapar.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DAY_MS = 86_400_000;

/**
 * Tahmin eşikleri — veri azken tahmin YANILTICI olmasın diye bilerek muhafazakâr.
 * - En az 3 düşüm kaydı: iki kayıtla "hız" demek, tek bir baskıyı trend sanmaktır.
 * - En az 5 günlük yayılım: aynı gün art arda 3 düşüm günlük hızı kat kat şişirir.
 * - 45 gündür dokunulmamış makara: eski hız artık geçerli değil, tahmin gösterilmez.
 */
const MIN_SAMPLES = 3;
const MIN_SPAN_DAYS = 5;
const MAX_IDLE_DAYS = 45;

interface UsageRow {
  id: string;
  grams: number;
  productId: string | null;
  productName: string | null;
  note: string | null;
  createdAt: Date;
}

interface UsagePace {
  gramsPerDay: number;
  sampleCount: number;
  spanDays: number;
  windowGrams: number;
}

/**
 * Dönen sayfadaki kayıtlardan günlük tüketim hızı. Yayılım EN ESKİ kayıttan ŞİMDİye ölçülür:
 * makara bir süredir kullanılmadıysa hız kendiliğinden düşer, yani tahmin iyimser değil
 * temkinli tarafa kayar. Yeterli veri yoksa null → arayüz hiçbir şey göstermez.
 */
function estimatePace(rows: UsageRow[], now: number): UsagePace | null {
  if (rows.length < MIN_SAMPLES) return null;

  const newest = rows[0].createdAt.getTime();
  const oldest = rows[rows.length - 1].createdAt.getTime();
  if (!Number.isFinite(newest) || !Number.isFinite(oldest)) return null;

  if ((now - newest) / DAY_MS > MAX_IDLE_DAYS) return null;

  const spanDays = (now - oldest) / DAY_MS;
  if (!(spanDays >= MIN_SPAN_DAYS)) return null;

  const windowGrams = rows.reduce((sum, row) => sum + (Number.isFinite(row.grams) ? row.grams : 0), 0);
  if (!(windowGrams > 0)) return null;

  return {
    gramsPerDay: windowGrams / spanDays,
    sampleCount: rows.length,
    spanDays,
    windowGrams,
  };
}

function parseLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const limit = parseLimit(req.nextUrl.searchParams.get("limit"));
    const cursor = req.nextUrl.searchParams.get("cursor")?.trim() || null;

    // take: limit + 1 → "daha var mı" bilgisi ayrı bir COUNT sorgusu olmadan çıkar.
    const rows: UsageRow[] = await prisma.filamentUsage.findMany({
      where: { spoolId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        grams: true,
        productId: true,
        productName: true,
        note: true,
        createdAt: true,
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const now = Date.now();

    return NextResponse.json({
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
      // Hız yalnız ilk sayfada anlamlı — sonraki sayfalar geçmişe doğru gider, "son hız" değil.
      pace: cursor ? null : estimatePace(items, now),
      // "Biteceği tarih" ekranda bu zamana göre yazılır; arayüz render sırasında saat okumasın.
      now,
    });
  } catch (error) {
    return jsonError(error);
  }
}
