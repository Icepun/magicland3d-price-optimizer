/**
 * Yazıcı durumu için PAYLAŞILAN süreç-içi önbellek.
 *
 * Neden: panel API (5sn) ve relay (10sn) aynı yazıcıları BAĞIMSIZ canlı yokluyordu → çift LAN
 * trafiği; üstelik çevrimdışı bir yazıcı her panel çağrısını 1.5–2.2sn geciktiriyordu (yanıt =
 * en yavaş yazıcı). Bu modül:
 *   1) Taze sonucu (≤4sn) iki tüketiciye de tek yoklamadan verir (eşzamanlı istekler tek uçuşta birleşir).
 *   2) ÇEVRİMDIŞI yazıcıyı 30sn'de bir dener; arada önbellekten ANINDA döner → panel hızlı kalır.
 *   3) Tek seferlik yoklama kaçağında (paket düşmesi/nginx meşgul) hemen "çevrimdışı" göstermez:
 *      son 25sn içinde çevrimiçi görülen yazıcı için İLK başarısız yoklamada son-iyi durum verilir
 *      (şüpheli işaretlenir); ikinci ardışık başarısızlık gerçek çevrimdışı sayılır (kart titremez).
 */
import {
  fetchMoonrakerStatus, fetchMoonrakerMeta,
  type MoonrakerStatus, type MoonrakerMeta,
} from "./moonraker";
import { getBambuStatus, type BambuStatus } from "./bambu";
import { prisma } from "@/lib/prisma";

const FRESH_MS = 4_000;          // çevrimiçi sonuç bu kadar süre taze sayılır (panel 5sn + relay 10sn paylaşır)
const OFFLINE_RETRY_MS = 30_000; // çevrimdışı yazıcı bu aralıkla yeniden denenir
const GRACE_MS = 25_000;         // son-iyi durumun "tek kaçak" için geçerli kalma penceresi

interface Entry<T> { at: number; value: T; offline: boolean; suspect: boolean }
const statusCache = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

async function withCache<T>(
  key: string,
  probe: () => Promise<T>,
  isOffline: (v: T) => boolean,
): Promise<T> {
  const e = statusCache.get(key) as Entry<T> | undefined;
  const now = Date.now();
  if (e && now - e.at < (e.offline ? OFFLINE_RETRY_MS : FRESH_MS)) return e.value;
  const inf = inflight.get(key);
  if (inf) return inf as Promise<T>;

  const p = (async () => {
    try {
      const v = await probe();
      const off = isOffline(v);
      // HİSTEREZİS: az önce çevrimiçiydi + ilk başarısız yoklama → son-iyi durumu bir kez daha
      // ver (kart "çevrimdışı" diye titremesin); bir SONRAKİ başarısızlık gerçek çevrimdışı.
      if (off && e && !e.offline && !e.suspect && now - e.at < GRACE_MS) {
        statusCache.set(key, { ...e, at: Date.now(), suspect: true });
        return e.value;
      }
      statusCache.set(key, { at: Date.now(), value: v, offline: off, suspect: false });
      return v;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function getMoonrakerStatusCached(host: string, port: number): Promise<MoonrakerStatus> {
  return withCache(`m|${host}:${port}`, () => fetchMoonrakerStatus(host, port), (v) => !v.online);
}

export function getBambuStatusCached(host: string, accessCode: string, serial: string): Promise<BambuStatus> {
  return withCache(`b|${host}|${serial}`, () => getBambuStatus(host, accessCode, serial), (v) => !v.online);
}

// ── Moonraker dosya metası — dosya başına DEĞİŞMEZ, süresiz önbellek ─────────────────────────
// Panel (5sn) + relay (10sn) baskı boyunca aynı filename için aynı HTTP çağrısını tekrarlıyordu.
const metaCache = new Map<string, MoonrakerMeta>();

export async function getMoonrakerMetaCached(host: string, port: number, filename: string): Promise<MoonrakerMeta | null> {
  const k = `${host}|${filename}`;
  const hit = metaCache.get(k);
  if (hit) return hit;
  const m = await fetchMoonrakerMeta(host, port, filename);
  if (m) {
    if (metaCache.size > 300) metaCache.clear(); // basit üst sınır — pratikte dolmaz
    metaCache.set(k, m);
  }
  return m; // null önbelleklenmez (metadata taraması gecikmiş olabilir → sonra tekrar dene)
}

// ── PrintFileProduct eşleştirmeleri — 30sn TTL (panelde her 5sn sınırsız findMany yerine) ─────
type MatchRow = { printerConfigId: string; filename: string; productId: string };
let matchesCache: { at: number; rows: MatchRow[] } | null = null;
const MATCHES_TTL_MS = 30_000;

export async function getPrintFileMatches(): Promise<MatchRow[]> {
  if (matchesCache && Date.now() - matchesCache.at < MATCHES_TTL_MS) return matchesCache.rows;
  const rows = await prisma.printFileProduct.findMany({
    select: { printerConfigId: true, filename: true, productId: true },
  });
  matchesCache = { at: Date.now(), rows };
  return rows;
}

/** Eşleştirme yazan herkes çağırır (match modalı / baskı başlatma) → panel yeni eşleşmeyi ANINDA görür. */
export function invalidatePrintFileMatches(): void {
  matchesCache = null;
}
