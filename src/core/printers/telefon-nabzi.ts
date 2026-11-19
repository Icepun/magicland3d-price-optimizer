import { remotePrisma } from "@/lib/prisma";
import { processSingleton } from "./process-singleton";

/**
 * TELEFON NABZI — "telefondan bekleyen iş var mı?" sorusunun TEK sorgusu.
 *
 * ── 19 Kas 2026 denetimi ─────────────────────────────────────────────────────────────────────
 * Aynı soruyu üç ayrı zamanlayıcı soruyordu ve neredeyse her seferinde cevap "yok"tu:
 *   - kamera isteği   3 sn'de bir  (günde 7.500 sorgu)
 *   - etiket isteği   5 sn'de bir  (günde 9.900 sorgu)
 *   - baskı komutu   10 sn'de bir  (günde 4.800 sorgu)
 * Hepsi arka plan şeridinde, relay'in yazmalarıyla aynı kuyrukta.
 *
 * Şimdi 3 sn'de bir TEK küçük sayım sorgusu çalışır; yalnız sayısı sıfırdan büyük olan işin
 * kendi (ayrıntı) sorgusu tetiklenir. Kamera aynı hızda fark edilir (≤3 sn); etiket ve komut
 * DAHA HIZLI (5 ve 10 sn yerine ≤3 sn).
 *
 * Sayım okunamazsa (ağ, tablo henüz yok) dinleyicilere `null` gider ve her biri eskisi gibi
 * kendi sorgusunu atar — nabız bozulursa hiçbir iş sessizce durmaz.
 */
export interface TelefonNabzi {
  kamera: number;
  etiket: number;
  komut: number;
}

export const NABIZ_MS = 3_000;

export function nabizSql(): string {
  return `SELECT
    (SELECT COUNT(*) FROM "PrinterCamera" WHERE "wantedUntilMs" > ?1) AS "kamera",
    (SELECT COUNT(*) FROM "LabelPrintRequest" WHERE "status" = 'pending') AS "etiket",
    (SELECT COUNT(*) FROM "PrintCommand" WHERE "status" = 'pending') AS "komut"`;
}

type Dinleyici = (nabiz: TelefonNabzi | null) => void | Promise<void>;

const durum = processSingleton("telefon_nabzi", () => ({
  basladi: false,
  turda: false,
  /** Son TAMAMLANAN tur (başarılı ya da değil) — relay "nabız yaşıyor mu" diye bakar. */
  sonAt: 0,
  dinleyiciler: new Map<string, Dinleyici>(),
}));

/** Bir iş türünü nabza bağla. Aynı adla yeniden bağlamak öncekinin yerine geçer. */
export function nabizDinle(ad: string, dinleyici: Dinleyici): void {
  durum.dinleyiciler.set(ad, dinleyici);
}

/** Son turun bittiği an (epoch-ms); hiç tur dönmediyse 0. */
export function nabizSonAt(): number {
  return durum.sonAt;
}

function dbDuraklatildi(): boolean {
  return (globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__ === true;
}

export async function telefonNabziOku(simdi: number): Promise<TelefonNabzi | null> {
  try {
    const satirlar = await remotePrisma.$queryRawUnsafe<Record<string, unknown>[]>(nabizSql(), simdi);
    const s = satirlar[0];
    if (!s) return null;
    return { kamera: Number(s.kamera ?? 0), etiket: Number(s.etiket ?? 0), komut: Number(s.komut ?? 0) };
  } catch {
    return null;
  }
}

/** Tek tur: sayımı oku, dinleyicilere dağıt. Dinleyiciler BEKLENMEZ — uzun süren bir iş
 *  (etiket basımı, kamera oturumu açma) diğerlerinin fark edilmesini geciktirmesin; her
 *  dinleyicinin kendi "önceki bitmeden başlama" koruması var. */
export async function nabizTuru(): Promise<void> {
  // Uyku/askı korumasındayken veritabanına dokunma (relay ile aynı kural).
  if (dbDuraklatildi() || durum.turda) return;
  durum.turda = true;
  try {
    const nabiz = await telefonNabziOku(Date.now());
    for (const dinleyici of durum.dinleyiciler.values()) {
      try {
        void Promise.resolve(dinleyici(nabiz)).catch(() => {
          /* dinleyici kendi hatasını yönetir; nabız durmaz */
        });
      } catch {
        /* eşzamanlı fırlatan dinleyici de nabzı durdurmaz */
      }
    }
  } finally {
    durum.sonAt = Date.now();
    durum.turda = false;
  }
}

/** Nabzı başlat (süreçte bir kez; birden çok yerden çağrılabilir). */
export function startTelefonNabzi(): void {
  if (durum.basladi) return;
  durum.basladi = true;
  const zamanlayici = setInterval(() => {
    void nabizTuru().catch(() => {
      /* sonraki tur dener */
    });
  }, NABIZ_MS);
  zamanlayici.unref?.();
}

/** Testler için. */
export function nabizSifirla(): void {
  durum.dinleyiciler.clear();
  durum.sonAt = 0;
  durum.turda = false;
}
