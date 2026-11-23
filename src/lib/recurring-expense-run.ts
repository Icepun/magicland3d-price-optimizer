import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { batchWrite } from "@/lib/libsql-batch";
import { parseDbDate, toDbDate } from "@/lib/sqlite-date";
import { uretilecekler, type TekrarKurali, type UretilecekGider } from "@/lib/recurring-expense";
import { gecerliGiderKdvOrani } from "@/core/gider-kdv";

/**
 * Vakti gelen tekrarlayan giderleri gerçek gider kaydına dönüştürür.
 *
 * ⚠️ NET KÂRI DEĞİŞTİRİR. Bu yüzden çalışma şekli bilinçli olarak kısıtlı:
 *   • Yalnız günü GELMİŞ dönemler yazılır (kural: `recurring-expense.ts`).
 *   • Aynı kural + aynı dönem İKİ KEZ yazılamaz — burada mevcut dönemler okunarak,
 *     veritabanında da kısmi UNIQUE indeksle. Bu fonksiyon her sayfa açılışında
 *     çağrıldığı için tek katmanlı koruma yeterli değil.
 *   • Kullanıcının SİLDİĞİ otomatik dönem (`RecurringExpenseSkip`, v64) bir daha açılmaz — yine iki
 *     katman: okunan atla satırları + INSERT'in kendi `NOT EXISTS` koşulu (okuma ile yazma arasında
 *     silinen dönem de geri gelmesin). Eskiden silinen sabit gider bir sonraki açılışta geri
 *     geliyordu (denetim, 23 Kas 2026).
 *   • Yazılan satır `recurringId` taşır: kullanıcı hangi kaydın otomatik geldiğini görür,
 *     düzenleyebilir ve silebilir. Kuralın KDV oranı da kayda geçer.
 *
 * HAM SQL: `RecurringExpense` ve `ActualExpense.recurringId` şemaya bu sürümde eklendi;
 * üretilmiş Prisma istemcisi çalışan uygulamada kilitli olduğu için henüz tanımıyor.
 * Aynı yol `planner-insights` ucunda da kullanılıyor.
 *
 * PERFORMANS: uzak veritabanında her sorgu sıraya giriyor. Hiç kural yoksa TEK sorguda
 * çıkılır; yazılacak bir şey yoksa iki sorguda (var olan + atlanan dönemler tek sorguda). Yazma
 * tek batch'te gider.
 */
export async function ensureRecurringExpenses(nowMs = Date.now()): Promise<number> {
  const kuralSatirlari = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id","name","category","amountKurus","dayOfMonth","startsAt","endsAt","note","vatRate"
       FROM "RecurringExpense" WHERE "isActive" = 1`
  );
  if (kuralSatirlari.length === 0) return 0;

  // Açılmış VE kullanıcının sildiği dönemler aynı küme: ikisi de "bu dönemi açma" demek.
  // Atla tablosu okunamazsa üretim DURUR (hata yukarı çıkar) — silinen giderleri geri getirmektense
  // bu turu atlamak doğru; çağıranlar hatayı günlüğe yazıp devam ediyor.
  const varOlanlar = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "recurringId","periodKey" FROM "ActualExpense"
      WHERE "recurringId" IS NOT NULL AND "periodKey" IS NOT NULL
     UNION ALL
     SELECT "recurringId","periodKey" FROM "RecurringExpenseSkip"`
  );
  const donemlerById = new Map<string, Set<string>>();
  for (const row of varOlanlar) {
    const id = String(row.recurringId ?? "");
    const period = String(row.periodKey ?? "");
    if (!id || !period) continue;
    let set = donemlerById.get(id);
    if (!set) {
      set = new Set<string>();
      donemlerById.set(id, set);
    }
    set.add(period);
  }

  const acilacak: UretilecekGider[] = [];
  const kdvById = new Map<string, number | null>();
  for (const row of kuralSatirlari) {
    const id = String(row.id ?? "");
    if (!id) continue;
    kdvById.set(id, gecerliGiderKdvOrani(row.vatRate));
    const kural: TekrarKurali = {
      id,
      name: String(row.name ?? ""),
      category: row.category == null ? null : String(row.category),
      amountKurus: Number(row.amountKurus ?? 0),
      dayOfMonth: Number(row.dayOfMonth ?? 1),
      startsAtMs: parseDbDate(row.startsAt)?.getTime() ?? Number.NaN,
      endsAtMs: parseDbDate(row.endsAt)?.getTime() ?? null,
      isActive: true,
      note: row.note == null ? null : String(row.note),
    };
    acilacak.push(...uretilecekler(kural, donemlerById.get(id) ?? [], nowMs));
  }
  if (acilacak.length === 0) return 0;

  const simdi = toDbDate(new Date(nowMs));
  const satirlar = acilacak.map((g) => ({
    sql:
      `INSERT OR IGNORE INTO "ActualExpense"
         ("id","name","category","amountKurus","paidAt","note","recurringId","periodKey","vatRate","createdAt","updatedAt")
       SELECT ?,?,?,?,?,?,?,?,?,?,?
        WHERE NOT EXISTS (
          SELECT 1 FROM "RecurringExpenseSkip" WHERE "recurringId" = ? AND "periodKey" = ?
        )`,
    args: [
      randomUUID(),
      g.name,
      g.category,
      g.amountKurus,
      toDbDate(new Date(g.paidAtMs)),
      g.note,
      g.recurringId,
      g.periodKey,
      kdvById.get(g.recurringId) ?? null,
      simdi,
      simdi,
      g.recurringId,
      g.periodKey,
    ] as Array<string | number | null>,
  }));

  const ok = await batchWrite(satirlar);
  // Uzak-HTTP dışı kurulumlarda batch yolu yok; tek tek yazılır (satır sayısı ayda birkaç).
  // `INSERT OR IGNORE` sayesinde ikinci yazma sessizce elenir.
  if (!ok) {
    for (const satir of satirlar) {
      await prisma.$executeRawUnsafe(satir.sql, ...satir.args);
    }
  }
  return acilacak.length;
}
