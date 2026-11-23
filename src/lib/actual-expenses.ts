import { NextResponse } from "next/server";
import { z } from "zod";
import { GIDER_KDV_ORANLARI, gecerliGiderKdvOrani } from "@/core/gider-kdv";
import { batchWriteDurumu } from "./libsql-batch";
import { kurusToTl } from "./monthly-finance";
import { prisma, remotePrisma } from "./prisma";
import { parseDbDate, toDbDate } from "./sqlite-date";

/**
 * Giderin KDV oranı: Yok (null) / %1 / %10 / %20. 0 da "yok" sayılır.
 * Kural tek yerde (`core/gider-kdv.ts`): boş oran KDV indirmez, eski kayıtların rakamı değişmez.
 */
export const GiderKdvOraniInput = z
  .number()
  .nullable()
  .optional()
  .refine(
    (v) => v == null || v === 0 || (GIDER_KDV_ORANLARI as readonly number[]).includes(v),
    "KDV oranı Yok, %1, %10 ya da %20 olmalı"
  );

export const ActualExpenseInput = z.object({
  name: z.string().trim().min(1, "Gider adı boş olamaz").max(120),
  category: z.string().trim().max(60).nullable().optional(),
  amount: z
    .number()
    .finite()
    .positive("Tutar sıfırdan büyük olmalı")
    .max(21_474_836.47, "Tutar desteklenen sınırı aşıyor"),
  paidAt: z.coerce.date(),
  note: z.string().trim().max(500).nullable().optional(),
  vatRate: GiderKdvOraniInput,
});

/** Formdan gelen oranı kayda çevirir: geçersiz/0 → null (KDV indirilmez). */
export function kayitKdvOrani(value: number | null | undefined): number | null {
  return gecerliGiderKdvOrani(value);
}

export function optionalExpenseText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function actualExpenseResponse(expense: {
  id: string;
  name: string;
  category: string | null;
  amountKurus: number;
  paidAt: Date;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  vatRate?: number | null;
}) {
  const { amountKurus, ...rest } = expense;
  return { ...rest, vatRate: gecerliGiderKdvOrani(expense.vatRate), amount: kurusToTl(amountKurus) };
}

/**
 * Ham SQL satırını arayüzün beklediği gövdeye çevirir.
 *
 * `recurringId` dolu olan satır TEKRARLAYAN KURALDAN otomatik açılmıştır; arayüz bunu
 * rozetle gösteriyor ki kullanıcı "bunu ben mi girdim" diye tereddüt etmesin.
 */
export function expenseRowResponse(row: Record<string, unknown>) {
  const kurus = typeof row.amountKurus === "bigint" ? Number(row.amountKurus) : Number(row.amountKurus ?? 0);
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    category: row.category == null ? null : String(row.category),
    amount: kurusToTl(kurus),
    paidAt: parseDbDate(row.paidAt)?.toISOString() ?? null,
    note: row.note == null ? null : String(row.note),
    recurringId: row.recurringId == null ? null : String(row.recurringId),
    vatRate: gecerliGiderKdvOrani(row.vatRate),
    createdAt: parseDbDate(row.createdAt)?.toISOString() ?? null,
    updatedAt: parseDbDate(row.updatedAt)?.toISOString() ?? null,
  };
}

export function actualExpenseValidationError(error: unknown) {
  if (!(error instanceof z.ZodError)) return null;
  return NextResponse.json(
    { error: error.issues[0]?.message ?? "Geçersiz gider bilgisi" },
    { status: 400 }
  );
}

/* ─────────────────────────── Tek parça yazma ─────────────────────────── */

export type YazmaIfadesi = { sql: string; args: Array<string | number | null> };

/** Ağ isteği gönderildi ama sonuç belirsiz — çağıran kullanıcıya "tekrar dene" der. */
export class TekParcaYazilamadi extends Error {
  constructor() {
    super("Kaydedilemedi. Bağlantını kontrol edip tekrar dene.");
    this.name = "TekParcaYazilamadi";
  }
}

/**
 * Birlikte uygulanması GEREKEN yazmalar — ya hepsi ya hiçbiri.
 *
 * Uzak-HTTP'de libSQL `batch()` tek istek ve tek işlemdir. Bu modda yoksa (yerel SQLite, gömülü
 * replika) Prisma işlemi kullanılır. İstek gönderilip DÜŞTÜYSE yeniden gönderilmez (sunucuda
 * uygulanmış olabilir): hata fırlatılır, kullanıcı tekrar dener.
 */
export async function tekParcaYaz(
  ifadeler: YazmaIfadesi[],
  istemci: typeof prisma | typeof remotePrisma = remotePrisma
): Promise<void> {
  if (ifadeler.length === 0) return;
  const durum = await batchWriteDurumu(ifadeler);
  if (durum === "ok") return;
  if (durum === "basarisiz") throw new TekParcaYazilamadi();
  await istemci.$transaction(ifadeler.map((i) => istemci.$executeRawUnsafe(i.sql, ...i.args)));
}

/**
 * Gider kaydını silen ifadeler.
 *
 * Kayıt bir SABİT GİDER kuralından otomatik açıldıysa (recurringId + periodKey dolu) aynı işlemde
 * "atla" satırı da yazılır: üretim o dönemi bir daha AÇMAZ. Bu olmadan silinen otomatik gider bir
 * sonraki açılışta geri geliyordu (denetim, 23 Kas 2026). Atla satırı silinen kaydın KENDİSİNDEN
 * okunur (INSERT … SELECT) — ayrı okuma ile yazma arasına başka bir değişiklik giremez.
 */
export function giderSilmeIfadeleri(id: string, simdi = new Date()): YazmaIfadesi[] {
  return [
    {
      sql: `INSERT OR IGNORE INTO "RecurringExpenseSkip" ("recurringId","periodKey","createdAt")
            SELECT "recurringId","periodKey", ? FROM "ActualExpense"
             WHERE "id" = ? AND "recurringId" IS NOT NULL AND "periodKey" IS NOT NULL`,
      args: [toDbDate(simdi), id],
    },
    { sql: `DELETE FROM "ActualExpense" WHERE "id" = ?`, args: [id] },
  ];
}
