import { bustFinanceCaches } from "@/lib/cache-busting";
import { NextRequest, NextResponse } from "next/server";
import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { kurusToTl, tlToKurus } from "@/lib/monthly-finance";
import {
  ActualExpenseInput,
  actualExpenseResponse,
  actualExpenseValidationError,
  expenseRowResponse,
  kayitKdvOrani,
  optionalExpenseText,
} from "@/lib/actual-expenses";
import { ensureRecurringExpenses } from "@/lib/recurring-expense-run";
import { dbEpochMs } from "@/lib/sqlite-date";
import { giderNetKurus } from "@/core/gider-kdv";

export async function GET(req: NextRequest) {
  await ensureRuntimeSchema();
  // Vakti gelen sabit giderler burada gerçek kayda dönüşür. Sayfayı açmak bu yüzden yeterli;
  // ayrı bir "oluştur" adımı yok. Yazılacak bir şey yoksa iki sorguda çıkar.
  // Üretim düşerse liste yine gelsin (Raporlar da aynı çağrıyı korumalı yapıyor); bir sonraki açılış tamamlar.
  await ensureRecurringExpenses().catch((e) => console.error("[sabit-gider] üretilemedi:", e));

  // Panel'in net kârı: verilen andan BUGÜNE kadar ödenen giderlerin toplamı. Sipariş özetiyle
  // AYNI pencere başlangıcı kullanılır (`summary.from`), yoksa iki rakam farklı günleri anlatır.
  const params = new URL(req.url).searchParams;
  if (params.get("toplam") === "1") {
    const fromMs = Date.parse(params.get("from") ?? "");
    if (!Number.isFinite(fromMs)) {
      return NextResponse.json({ error: "Dönem başlangıcı anlaşılmadı." }, { status: 400 });
    }
    // Net kârdan düşen tutar: KDV oranı girilmiş giderde KDV HARİÇ (aylık rapordaki kuralın
    // aynısı, `core/gider-kdv.ts`). Oranı boş gider tutarın tamamıyla düşer — eski toplamla aynı.
    const rows = await remotePrisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "amountKurus","vatRate"
         FROM "ActualExpense"
        WHERE ${dbEpochMs("paidAt")} >= ? AND ${dbEpochMs("paidAt")} <= ?`,
      fromMs,
      Date.now()
    );
    const toplamKurus = rows.reduce(
      (t, r) => t + giderNetKurus(Number(r.amountKurus ?? 0), r.vatRate),
      0
    );
    return NextResponse.json(
      {
        from: new Date(fromMs).toISOString(),
        toplam: kurusToTl(toplamKurus),
        adet: rows.length,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  // HAM SQL: `recurringId` bu sürümde eklendi ve üretilmiş Prisma istemcisi onu henüz
  // tanımıyor. Arayüz hangi kaydın otomatik geldiğini bu alandan biliyor.
  // Sıralama `dbEpochMs` ile: kolonda hem epoch-ms tamsayı hem ISO metin bulunabiliyor ve
  // düz sıralamada tamsayı her zaman metinden küçük sayılır (bkz. src/lib/sqlite-date.ts).
  const rows = await remotePrisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id","name","category","amountKurus","paidAt","note","recurringId","vatRate",
            "createdAt","updatedAt"
       FROM "ActualExpense"
      ORDER BY ${dbEpochMs("paidAt")} DESC, ${dbEpochMs("createdAt")} DESC`
  );
  return NextResponse.json(rows.map(expenseRowResponse), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const data = ActualExpenseInput.parse(await req.json());
    const expense = await remotePrisma.actualExpense.create({
      data: {
        name: data.name,
        category: optionalExpenseText(data.category),
        amountKurus: tlToKurus(data.amount),
        paidAt: data.paidAt,
        note: optionalExpenseText(data.note),
        vatRate: kayitKdvOrani(data.vatRate),
      },
    });
    // Gerçek gider aylık net kâra girer → finans geçmişi önbelleği tazelensin
    // (bu olmadan gider eklendikten sonra aylık rapor 1 dakika değişmiyordu).
    bustFinanceCaches();
    return NextResponse.json(actualExpenseResponse(expense), { status: 201 });
  } catch (error) {
    const response = actualExpenseValidationError(error);
    if (response) return response;
    throw error;
  }
}
