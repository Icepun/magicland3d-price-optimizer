import { toDbDate } from "@core/sqlite-date";
import { yeniKuralBaslangiciMs } from "@core/tariff-period";
import {
  komisyonKuraliGuncellemePlani,
  komisyonKuraliSilmePlani,
  komisyonKuraliYenidenAcmaPlani,
  kuralYururlukte as kuralYururluktedir,
  type KomisyonKuraliKaydi,
} from "@core/komisyon-kurali-donem";
import { execute, query, writeBatch } from "@/lib/turso";
import { ensureCargoVatSchema, ensureCommissionPlatformSchema } from "@/lib/db/schema";

function newId(): string {
  return (
    "c" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

export type ExpenseType = "fixed" | "percentage" | "per_order";

export interface ExpenseRuleFull {
  id: string;
  name: string;
  platform: string | null;
  type: ExpenseType;
  value: number; // percentage ise kesir (0.20), değilse TL
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  priority: number;
  isActive: number;
}

/** Tüm ek gider kuralları (pasifler dahil — yönetim listesi). */
export async function getAllExpenseRules(): Promise<ExpenseRuleFull[]> {
  return query<ExpenseRuleFull>(
    `SELECT id, name, platform, type, value, categoryName, minPrice, maxPrice, priority, isActive
       FROM ExpenseRule ORDER BY priority DESC, name ASC`
  );
}

export interface ExpenseRuleDraft {
  name: string;
  platform: string | null;
  type: ExpenseType;
  value: number; // percentage ise kesir
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
}

export async function createExpenseRule(d: ExpenseRuleDraft): Promise<void> {
  await execute(
    `INSERT INTO ExpenseRule (id, name, platform, type, value, categoryName, minPrice, maxPrice, priority, isActive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, 1)`,
    [newId(), d.name, d.platform, d.type, d.value, d.categoryName, d.minPrice, d.maxPrice]
  );
}

export async function updateExpenseRule(id: string, d: ExpenseRuleDraft): Promise<void> {
  await execute(
    `UPDATE ExpenseRule SET name=?, platform=?, type=?, value=?, categoryName=?, minPrice=?, maxPrice=? WHERE id=?`,
    [d.name, d.platform, d.type, d.value, d.categoryName, d.minPrice, d.maxPrice, id]
  );
}

export async function deleteExpenseRule(id: string): Promise<void> {
  await execute(`DELETE FROM ExpenseRule WHERE id=?`, [id]);
}

export async function setExpenseRuleActive(id: string, active: boolean): Promise<void> {
  await execute(`UPDATE ExpenseRule SET isActive=? WHERE id=?`, [active ? 1 : 0, id]);
}

/** AppSetting key güncelle/ekle (KDV oranı, komisyon vb.). */
export async function updateSetting(key: string, value: string): Promise<void> {
  await execute(
    `INSERT INTO AppSetting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

/** Birden çok AppSetting'i TEK round-trip'te ve TEK PARÇA yaz — ayarlar ekranı 6 alanı
 *  eskiden 6 ardışık upsert ile kaydediyordu (~300-1200ms + yarıda kalma riski). */
export async function updateSettings(entries: Record<string, string>): Promise<void> {
  const stmts = Object.entries(entries).map(([key, value]) => ({
    sql: `INSERT INTO AppSetting (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  }));
  if (stmts.length > 0) await writeBatch(stmts);
}

// ===================== KOMİSYON KURALLARI =====================
// DÖNEMLİ (masaüstüyle aynı çekirdek plan, `core/komisyon-kurali-donem.ts`): geçmişte başlamış
// kuralın oranı değişince eski kural bugün kapanır, yenisi bugünden başlar; silme/kapatma da
// geçmişi silmez, bugün kapatır. Yeni kural bu ayın 1'inden başlar.

export interface CommissionRuleFull {
  id: string;
  name: string;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  commissionRate: number; // kesir (0.21)
  fixedCommission: number;
  priority: number;
  isActive: number;
  /** "trendyol" | "hepsiburada"; boş = eski kural (Trendyol). */
  platform: string | null;
  /** Epoch-ms sayı ya da ISO metin olabilir (`kuralTarihMs`). */
  validFrom: unknown;
  validTo: unknown;
}

export interface CommissionDraft {
  name: string;
  categoryName: string | null;
  commissionRate: number; // kesir
  fixedCommission: number;
  minPrice: number;
  maxPrice: number;
  /** Aynı ürüne birden çok kural uyarsa yüksek olan geçerli (masaüstüyle aynı alan). */
  priority?: number;
  /** "trendyol" | "hepsiburada" — verilmezse Trendyol. */
  platform?: string;
}

const KOMISYON_KOLONLARI =
  "id, name, categoryName, minPrice, maxPrice, commissionRate, fixedCommission, priority, isActive, platform, validFrom, validTo";

export async function getAllCommissionRules(): Promise<CommissionRuleFull[]> {
  await ensureCommissionPlatformSchema();
  return query<CommissionRuleFull>(
    `SELECT ${KOMISYON_KOLONLARI} FROM CommissionRule ORDER BY priority DESC, name ASC`
  );
}

function satirdanKayit(r: CommissionRuleFull): KomisyonKuraliKaydi {
  const tarih = (v: unknown) => {
    const ms = kuralTarihMs(v);
    return ms == null ? null : new Date(ms);
  };
  return {
    id: r.id,
    name: r.name,
    categoryName: r.categoryName,
    minPrice: Number(r.minPrice),
    maxPrice: Number(r.maxPrice),
    commissionRate: Number(r.commissionRate),
    fixedCommission: Number(r.fixedCommission),
    priority: Number(r.priority),
    isActive: Number(r.isActive) === 1,
    platform: r.platform ?? null,
    validFrom: tarih(r.validFrom),
    validTo: tarih(r.validTo),
  };
}

async function komisyonKuraliOku(id: string): Promise<KomisyonKuraliKaydi> {
  await ensureCommissionPlatformSchema();
  const [r] = await query<CommissionRuleFull>(`SELECT ${KOMISYON_KOLONLARI} FROM CommissionRule WHERE id = ?`, [id]);
  if (!r) throw new Error("Kural bulunamadı — silinmiş olabilir");
  return satirdanKayit(r);
}

function yeniKuralIfadesi(k: Omit<KomisyonKuraliKaydi, "id">): { sql: string; args: (string | number | null)[] } {
  return {
    sql: `INSERT INTO CommissionRule (id, name, categoryName, minPrice, maxPrice, commissionRate, fixedCommission, priority, isActive, platform, validFrom, validTo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId(), k.name, k.categoryName, k.minPrice, k.maxPrice, k.commissionRate, k.fixedCommission, k.priority,
      k.isActive ? 1 : 0, k.platform, k.validFrom ? toDbDate(k.validFrom) : null, k.validTo ? toDbDate(k.validTo) : null,
    ],
  };
}

export async function createCommissionRule(d: CommissionDraft): Promise<void> {
  await ensureCommissionPlatformSchema();
  const an = Date.now();
  const ifade = yeniKuralIfadesi({
    name: d.name,
    categoryName: d.categoryName,
    minPrice: d.minPrice,
    maxPrice: d.maxPrice,
    commissionRate: d.commissionRate,
    fixedCommission: d.fixedCommission,
    priority: d.priority ?? 10,
    isActive: true,
    platform: d.platform ?? "trendyol",
    validFrom: new Date(yeniKuralBaslangiciMs([], an)),
    validTo: null,
  });
  await execute(ifade.sql, ifade.args);
}

export async function updateCommissionRule(id: string, d: CommissionDraft): Promise<void> {
  const eski = await komisyonKuraliOku(id);
  const plan = komisyonKuraliGuncellemePlani(
    eski,
    {
      name: d.name,
      categoryName: d.categoryName,
      minPrice: d.minPrice,
      maxPrice: d.maxPrice,
      commissionRate: d.commissionRate,
      fixedCommission: d.fixedCommission,
      ...(d.priority != null ? { priority: d.priority } : {}),
      ...(d.platform ? { platform: d.platform } : {}),
    },
    new Date()
  );
  if (plan.tur === "yerinde") {
    const v = { ...eski, ...plan.veri };
    await execute(
      `UPDATE CommissionRule SET name=?, categoryName=?, minPrice=?, maxPrice=?, commissionRate=?, fixedCommission=?, priority=?, platform=? WHERE id=?`,
      [v.name, v.categoryName, v.minPrice, v.maxPrice, v.commissionRate, v.fixedCommission, v.priority, v.platform, id]
    );
    return;
  }
  // Tek parça: eski dönem kapanır + yeni dönem açılır (biri düşerse ikisi de yazılmaz).
  await writeBatch([
    { sql: `UPDATE CommissionRule SET validTo=? WHERE id=?`, args: [toDbDate(plan.kapat.validTo), id] },
    yeniKuralIfadesi(plan.yeni),
  ]);
}

/**
 * Bu aydan önce başlamış kural ayın 1'inden itibaren kapanır (geçmiş aylar korunur); bu ay eklenmiş
 * kural gerçekten silinir. `tamamen` = kullanıcı geçmişten de kaldırmayı seçti.
 */
export async function deleteCommissionRule(id: string, tamamen = false): Promise<void> {
  const eski = await komisyonKuraliOku(id);
  const plan = komisyonKuraliSilmePlani(eski, new Date(), tamamen);
  if (plan.tur === "sil") await execute(`DELETE FROM CommissionRule WHERE id=?`, [id]);
  else await execute(`UPDATE CommissionRule SET validTo=? WHERE id=?`, [toDbDate(plan.validTo), id]);
}

/** Kapat = ayın 1'inden kapat (geçmiş aylar korunur); aç = kapanmış kuralın ayın 1'inden başlayan kopyası. */
export async function setCommissionRuleActive(id: string, active: boolean): Promise<void> {
  const eski = await komisyonKuraliOku(id);
  const an = new Date();
  if (!active) return deleteCommissionRule(id);
  if (kuralYururluktedir(eski, an)) return;
  const ifade = yeniKuralIfadesi(komisyonKuraliYenidenAcmaPlani(eski, an));
  await execute(ifade.sql, ifade.args);
}

/** Komisyon kuralı şu an yürürlükte mi (liste "geçerli" ve "geçmiş" diye ikiye ayrılır). */
export function komisyonKuraliYururlukte(r: CommissionRuleFull, simdiMs: number = Date.now()): boolean {
  return kuralYururluktedir(satirdanKayit(r), new Date(simdiMs));
}

// ===================== KARGO KURALLARI =====================

export interface CargoRuleFull {
  id: string;
  name: string;
  platform: string | null;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  minDesi: number;
  maxDesi: number;
  cargoCost: number;
  vatIncluded: number;
  priority: number;
  isActive: number;
  /**
   * Geçerlilik penceresi. Kargo tarifeleri dönem dönem değişiyor; eski kurallar SİLİNMİYOR,
   * `validTo` ile kapanıyor (geçmiş siparişler kendi dönemlerinin fiyatıyla hesaplanmalı).
   * Bu kolonlar okunmadığı için telefon süresi dolmuş baremleri güncel olanlarla yan yana
   * listeliyordu — her barem iki kez, iki farklı fiyatla.
   *
   * Tip `unknown`: kolon bazı kayıtlarda epoch-ms sayı, bazılarında ISO metin olabiliyor.
   */
  validFrom: unknown;
  validTo: unknown;
}

/** Epoch-ms sayı da ISO metin de olabilen tarih kolonunu ms'e çevirir. */
export function kuralTarihMs(deger: unknown): number | null {
  if (deger == null) return null;
  if (typeof deger === "number") return Number.isFinite(deger) ? deger : null;
  const t = Date.parse(String(deger));
  return Number.isNaN(t) ? null : t;
}

/** Kural verilen anda yürürlükte mi? */
export function kuralYururlukte(r: CargoRuleFull, simdiMs: number): boolean {
  const bas = kuralTarihMs(r.validFrom);
  const bit = kuralTarihMs(r.validTo);
  if (bas != null && simdiMs < bas) return false;
  if (bit != null && simdiMs > bit) return false;
  return true;
}

export interface CargoDraft {
  name: string;
  platform: string | null;
  categoryName: string | null;
  minDesi: number;
  maxDesi: number;
  minPrice: number;
  maxPrice: number;
  cargoCost: number;
  vatIncluded: boolean;
}

export async function getAllCargoRules(): Promise<CargoRuleFull[]> {
  await ensureCargoVatSchema();
  return query<CargoRuleFull>(
    `SELECT id, name, platform, categoryName, minPrice, maxPrice, minDesi, maxDesi, cargoCost, vatIncluded, priority, isActive, validFrom, validTo
       FROM CargoRule ORDER BY platform, minDesi ASC`
  );
}

/**
 * Yeni kuralın başlangıcı: BU AYIN 1'i (dönem bu aydan sonra başladıysa dönemin başı) — karar
 * çekirdekte, masaüstüyle AYNI tanım (Berke: "tüm kasıma etki etsin, öncesine değil").
 */
async function yeniKuralBaslangici(platform: string): Promise<number> {
  // Ham SQL kolonu sayı da metin de olabiliyor; çekirdek ikisini de çözüyor (eleme çekirdekte).
  const satirlar = await query<{ validFrom: string | number | null; validTo: string | number | null }>(
    `SELECT validFrom, validTo FROM CargoRule WHERE platform = ?`,
    [platform]
  );
  return yeniKuralBaslangiciMs(satirlar, Date.now());
}

export async function createCargoRule(d: CargoDraft): Promise<void> {
  await ensureCargoVatSchema();
  // Platformsuz kural şema göçlerinde Trendyol'a taşınıyordu → telefonda düzenlenebilir kural Shopify.
  const platform = d.platform ?? "shopify";
  const basMs = await yeniKuralBaslangici(platform);
  // Masaüstüyle AYNI biçimde yaz (toDbDate). Ham ms sayısı yazılırsa kolon karışık biçimli olur;
  // tarih filtreleri karışık kolonda satırları sessizce eleyebiliyor (Raporlar'ın %78'i böyle kaybolmuştu).
  const validFrom = toDbDate(new Date(basMs));
  await execute(
    `INSERT INTO CargoRule (id, name, platform, categoryName, minPrice, maxPrice, minDesi, maxDesi, cargoCost, vatIncluded, validFrom, priority, isActive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, 1)`,
    [newId(), d.name, platform, d.categoryName, d.minPrice, d.maxPrice, d.minDesi, d.maxDesi, d.cargoCost, d.vatIncluded ? 1 : 0, validFrom]
  );
}

export async function updateCargoRule(id: string, d: CargoDraft): Promise<void> {
  await ensureCargoVatSchema();
  await execute(
    `UPDATE CargoRule SET name=?, platform=?, categoryName=?, minPrice=?, maxPrice=?, minDesi=?, maxDesi=?, cargoCost=?, vatIncluded=? WHERE id=?`,
    [d.name, d.platform, d.categoryName, d.minPrice, d.maxPrice, d.minDesi, d.maxDesi, d.cargoCost, d.vatIncluded ? 1 : 0, id]
  );
}

export async function deleteCargoRule(id: string): Promise<void> {
  await ensureCargoVatSchema();
  await execute(`DELETE FROM CargoRule WHERE id=?`, [id]);
}

export async function setCargoRuleActive(id: string, active: boolean): Promise<void> {
  await ensureCargoVatSchema();
  await execute(`UPDATE CargoRule SET isActive=? WHERE id=?`, [active ? 1 : 0, id]);
}
