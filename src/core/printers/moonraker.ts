/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Moonraker (Klipper) HTTP adaptörü — Elegoo Neptune 4 Pro/Plus, Snapmaker U1.
 * Endpoint sözleşmesi Moonraker dokümanından doğrulandı:
 *   GET  /printer/info
 *   GET  /printer/objects/query?print_stats&virtual_sdcard=progress&display_status=progress&extruder=temperature,target&heater_bed=temperature,target
 *   POST /printer/print/{pause|resume|cancel}
 *   POST /printer/print/start?filename=...
 *   GET  /server/files/list?root=gcodes
 *   GET  /server/files/metadata?filename=...
 *   GET  /server/files/gcodes/<relative_path>   (thumbnail)
 * Yanıtlar { result: ... } ile sarılı gelir; defansif olarak result ?? gövde okunur.
 *
 * PORT FARKI (önemli): Elegoo Neptune 4 serisi Moonraker'ı nginx ARKASINDAN **port 80**'de
 * sunar (Fluidd de 80'de). Snapmaker U1 / standart Klipper ise **7125**'te. Bu yüzden
 * yapılandırılan port çalışmazsa otomatik olarak 80 ve 7125 denenir; çalışan port host
 * bazında önbelleğe alınır (sonraki isteklerde doğrudan kullanılır).
 */

import { processSingleton } from "./process-singleton";
import { timelapseKapakSec } from "./timelapse-name";
import { excludeObjectEkle, klipperParamKacisla } from "./exclude-object";
// Kaçışlama `exclude-object.ts`e taşındı (dosya üretimi de aynı kuralı kullanıyor);
// eski içe aktarmalar kırılmasın diye buradan yeniden dışa açılıyor.
export { klipperParamKacisla } from "./exclude-object";
import { aktarimBasladi, aktarimBitti } from "./transfer-state";
import http from "node:http";
import crypto from "node:crypto";
import { pickProgress, type ProgressSource } from "./eta";
import {
  parseGcodeThumbnails, pickLargestThumbnail, thumbnailDataUrl,
  parseGcodeEstimatedTimeSec, parseGcodeFilamentColours, parseGcodeFilamentGrams,
} from "./gcode-header";

export type MoonrakerState =
  | "standby"
  | "printing"
  | "paused"
  | "complete"
  | "cancelled"
  | "error";

export interface MoonrakerStatus {
  online: boolean;
  state: MoonrakerState;
  /** print_stats.message — hata/duraklatma nedeni (örn. "Filament runout"). Yoksa null. */
  message: string | null;
  filename: string | null;
  /** 0..1 — DOĞRU kaynaktan (M73 varsa dilimleyici tahmini, yoksa bayt oranı). */
  progress: number;
  /** İlerlemenin hangi kaynaktan geldiği (tanı + arayüz için). */
  progressSource: ProgressSource;
  /** display_status.progress — dilimleyicinin M73 P zaman tahmini (0..1). */
  slicerProgress: number | null;
  /** virtual_sdcard.progress — dosyanın okunan BAYT oranı (0..1). */
  byteProgress: number | null;
  /** virtual_sdcard.file_position / file_size — katman indeksine çevirmek için ham değerler. */
  filePosition: number | null;
  fileSize: number | null;
  printDurationSec: number;
  currentLayer: number | null;
  totalLayer: number | null;
  zHeight: number | null; // gcode_move.gcode_position[2] — layer tahmini için
  /** Nozul noktası (gcode_move.gcode_position X/Y) — canlı aşama görselleştirmesi için. */
  posX: number | null;
  posY: number | null;
  /** gcode_move.speed_factor → yüzde (M220). Bilinmiyorsa null. */
  speedPercent: number | null;
  nozzle: number;
  nozzleTarget: number;
  /**
   * TÜM kafalar (Snapmaker U1'de dört tane). `nozzle`/`nozzleTarget` bunlardan AKTİF olanı;
   * tek kafalı yazıcıda bu dizi tek elemanlıdır.
   */
  nozzles: NozzleTemp[];
  bed: number;
  bedTarget: number;
  /** Yazıcının O AN bastığı nesnenin adı (exclude_object.current_object). Yoksa null. */
  currentObject: string | null;
  /** Şimdiye kadar hariç tutulmuş nesne adları. */
  excludedObjects: string[];
}

/** Tek bir kafanın sıcaklığı. */
export interface NozzleTemp {
  /** 0 tabanlı kafa indeksi — "extruder"=0, "extruder1"=1 … */
  index: number;
  temp: number;
  target: number;
  /** Şu an baskıyı yapan kafa mı (toolhead.extruder). */
  active: boolean;
}

export interface MoonrakerMeta {
  estimatedTimeSec: number | null;
  thumbnailRelPath: string | null;
  /** Gcode'a gömülü küçük resim (Moonraker taramadıysa) — data URL. */
  thumbnailDataUrl: string | null;
  filamentType: string | null;
  /** Dilimleyicinin filament renkleri (mantıksal sıra) — "#RRGGBB". */
  filamentColours: string[];
  /** Toplam filament ağırlığı (gram) — YALNIZ GÖSTERİM; maliyet hesabına girmez. */
  filamentGrams: number | null;
  totalLayer: number | null;
  layerHeight: number | null;
  firstLayerHeight: number | null;
}

export interface MoonrakerFile {
  path: string;
  modified: number;
  size: number;
}

// file_position/file_size ve speed_factor AYNI istekte gelir — ek ağ maliyeti yok.
// exclude_object ALAN SEÇİMLİ istenir: çıplak hâli 3.770 bayt (%96'sı poligonlar), alan
// seçimli hâli 145 bayt. Poligonlar 5 saniyelik sıcak yola BİNMEZ; ayrı ve tek seferlik
// okunur (fetchMoonrakerExcludeObjects).
const QUERY =
  "print_stats&virtual_sdcard=progress,file_position,file_size&display_status=progress&extruder=temperature,target&extruder1=temperature,target&extruder2=temperature,target&extruder3=temperature,target&toolhead=extruder&heater_bed=temperature,target&gcode_move=gcode_position,speed_factor&exclude_object=current_object,excluded_objects";

/** host → çalışan Moonraker portu (runtime önbelleği). */
const portCache = processSingleton("mr_portCache", () => new Map<string, number>());

function candidatePorts(configured: number): number[] {
  return [...new Set([configured, 80, 7125].filter((p) => Number.isFinite(p) && p > 0))];
}

/**
 * SENKRON port çözümü — `moonrakerBase`'in zaten yaptığı arama, dışa açık hâli.
 *
 * ⚠️ `resolveMoonrakerPort` DEĞİL: o async ve içinde 1500 ms'lik ağ yoklaması var; kalıcı
 * WebSocket'i onunla beslemek çevrimdışı yazıcının "anında dön" garantisini bozardı.
 */
export function moonrakerPortu(host: string, port: number): number {
  return portCache.get(host) ?? lastGoodPort.get(host) ?? port ?? 7125;
}

/** Önbellekteki çalışan port (yoksa yapılandırılan) ile temel URL. */
export function moonrakerBase(host: string, port: number): string {
  // Kayıtlı port sahada yanlış olabiliyor → önce önbellek, sonra SON ÇALIŞAN, en son kayıtlı.
  const p = portCache.get(host) ?? lastGoodPort.get(host) ?? port ?? 7125;
  return `http://${host}:${p}`;
}

/**
 * ⚠️ ZAMAN AŞIMI GÖVDEYİ DE KAPSAMALI — yoksa uygulama donar.
 *
 * ESKİ HÂLİ: sayaç `finally` içinde temizleniyordu, yani `fetch()` çözülür çözülmez —
 * ki bu YALNIZ BAŞLIKLAR geldiğinde olur. AbortController orada silahsızlanıyor ve gövde
 * okuması sınırsız kalıyordu; ölçüldü: başlıklar 12-23 ms'de geliyor, gövde asılı kalıyor,
 * sert tavan undici'nin varsayılanı olan **305 saniye**.
 *
 * Zincir uçtan uca doğrulandı: asılı istek `status-cache` içindeki inflight tekilleştirmesi
 * yüzünden TÜM çağıranlara aynı sözü veriyor → `/api/printers` hiç dönmüyor (panel donuyor)
 * → relay'in re-entrancy koruması tick'i durduruyor → 30 sn'lik heartbeat kesiliyor →
 * telefon "masaüstü kapalı" alarmı veriyor. Tek bir yavaş gövde bunun için yeterli.
 *
 * Artık sayaç çağıranın gövdeyi okuması bitene kadar yaşıyor; `sonlandir()` ile kapatılır.
 */
function mfetchZamanli(url: string, init: RequestInit | undefined, timeoutMs: number) {
  const ctrl = new AbortController();
  const dis = init?.signal;
  if (dis) {
    if (dis.aborted) ctrl.abort();
    else dis.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const yanit = fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  return { yanit, sonlandir: () => clearTimeout(t) };
}

async function mfetch(url: string, init: RequestInit | undefined, timeoutMs: number) {
  const { yanit, sonlandir } = mfetchZamanli(url, init, timeoutMs);
  let res: Response;
  try {
    res = await yanit;
  } catch (e) {
    sonlandir();
    throw e;
  }
  /**
   * Sayaç, gövde tüketilene kadar açık kalır. Gövdeyi okumayan çağıranlar için (örn.
   * `if (!res.ok) return null`) soket havuzda asılı kalmasın diye burada da iptal edilir.
   */
  const orijinal = res;
  const bitir = () => sonlandir();
  const sarmalanmis = new Proxy(orijinal, {
    get(hedef, ad, alici) {
      if (ad === "json" || ad === "text" || ad === "arrayBuffer" || ad === "blob") {
        const f = Reflect.get(hedef, ad, hedef) as () => Promise<unknown>;
        return async () => {
          try {
            return await f.call(hedef);
          } finally {
            bitir();
          }
        };
      }
      const v = Reflect.get(hedef, ad, alici);
      return typeof v === "function" ? v.bind(hedef) : v;
    },
  });
  // Gövdesi hiç okunmayan yanıtlar için güvenlik ağı: sayaç zaten iptal edecek.
  return sarmalanmis as Response;
}

// ── PORT ÇÖZÜMLEME — kayıtlı port yanlışsa kendi kendini onarır ──────────────────────────────
//
// CANLI ÖLÇÜM (12 Ağu): Neptune 4 Pro (…18) ve Plus (…19) veritabanında port 7125 kayıtlı, ama
// ikisi de YALNIZ port 80'de yanıt veriyor (7125 bağlantıyı kabul etmiyor, istek 2 saniye asılı
// kalıp düşüyor). Eskiden yalnız `fetchMoonrakerStatus` adayları tarıyordu; uygulama yeni açılıp
// da ilk iş DURUM SORGUSU DEĞİLSE (ışık, yetenek keşfi, hız, dosya listesi…) istek doğrudan
// kayıtlı porta gidiyor ve boşa düşüyordu — kullanıcı "yazıcı bunu desteklemiyor" görüyordu.
//
// Artık her istek portu ÖNCE çözer:
//   • port önbellekte varsa AĞA HİÇ ÇIKILMAZ (ek gecikme yok, her istekte iki port denenmez),
//   • yoksa adaylar TEK SEFER, PARALEL yoklanır ve çalışan port önbelleğe alınır,
//   • tarama da başarısızsa kısa süre (30sn) tekrar taranmaz — kapalı yazıcı paneli yavaşlatmaz,
//   • kayıtlı portla üst üste birkaç istek düşerse port unutulur → sonraki istek yeniden keşfeder
//     (yazıcının adresi/portu gerçekten değiştiyse uygulama kendini onarır).
const portProbes = processSingleton("mr_portProbes", () => new Map<string, Promise<number | null>>());
const portProbeCooldown = processSingleton("mr_portProbeCooldown", () => new Map<string, number>());
const portFails = processSingleton("mr_portFails", () => new Map<string, number>());

const PORT_PROBE_TIMEOUT_MS = 1_500;
const PORT_PROBE_COOLDOWN_MS = 30_000;
/** Kayıtlı port bu kadar ardışık istekte düşerse unutulur (yeniden keşif). */
const PORT_FAILS_BEFORE_REDISCOVER = 3;

/**
 * SON ÇALIŞTIĞI BİLİNEN port — `portCache` temizlense bile kalır.
 *
 * ⚠️ NEDEN AYRI: keşif başarısız olunca eskiden `configured` porta dönülüyordu ve o port
 * SAHADA BOZUKTU (üç yazıcı da 7125 kayıtlı, üçü de yalnız 80'de yanıt veriyor). Sonuç:
 * keşfin düştüğü her 30 saniyelik pencerede TÜM istekler garanti başarısız oluyordu —
 * kullanıcının gördüğü "sürekli yazıcıya ulaşılamıyor" buydu.
 * Ölçüldü (13 Ağu): port 80 → 30/30 başarı · port 7125 → Elegoo'larda 0/10 (bağlantı
 * reddedildi), Snapmaker'da 6/10 ve 3 saniyeye kadar gecikme.
 */
const lastGoodPort = processSingleton("mr_lastGoodPort", () => new Map<string, number>());

/** Kalıcı yazma denemesi bir kez yapılır; her keşifte veritabanına gitmeyelim. */
const portPersisted = processSingleton("mr_portPersisted", () => new Set<string>());

/**
 * Keşfedilen portu YAPILANDIRMAYA yaz — yapılandırma bir kez kendini onarsın.
 *
 * Bu olmadan her uygulama açılışında aynı keşif tekrar ediliyor ve keşfin düştüğü ilk anda
 * sistem yine bozuk porta dönüyordu. Yazma başarısız olursa sessiz geçilir: çalışma anındaki
 * önbellek zaten doğru portu tutuyor, kalıcılık bir iyileştirmedir, zorunluluk değil.
 */
async function persistPort(host: string, port: number): Promise<void> {
  if (portPersisted.has(host)) return;
  portPersisted.add(host);
  try {
    const { prisma } = await import("@/lib/prisma");
    const updated = await prisma.printerConfig.updateMany({
      where: { host, port: { not: port } },
      data: { port },
    });
    if (updated.count > 0) {
      console.log(`[moonraker] ${host}: kayıtlı port ${port} olarak düzeltildi`);
    }
  } catch {
    /* yazılamadıysa çalışma anı önbelleği yeterli */
  }
}

/** Portu ÖĞRENDİK: ardışık hata sayacı ve tarama yasağı sıfırlanır. */
function rememberPort(host: string, port: number): void {
  portCache.set(host, port);
  lastGoodPort.set(host, port);
  portFails.delete(host);
  portProbeCooldown.delete(host);
  void persistPort(host, port);
}

function notePortOk(host: string, port: number): void {
  if (portCache.get(host) === port) portFails.delete(host);
  else rememberPort(host, port);
}

function notePortFailure(host: string, port: number): void {
  if (portCache.get(host) !== port) return; // zaten kayıtlı port değil
  const n = (portFails.get(host) ?? 0) + 1;
  if (n >= PORT_FAILS_BEFORE_REDISCOVER) {
    portCache.delete(host);
    portFails.delete(host);
  } else {
    portFails.set(host, n);
  }
}

/** Tek portta SALT OKUNUR yoklama — yanıt veren HTTP sunucusu var mı. */
async function pingMoonrakerPort(host: string, port: number): Promise<boolean> {
  try {
    const res = await mfetch(`http://${host}:${port}/printer/info`, undefined, PORT_PROBE_TIMEOUT_MS);
    return res.ok;
  } catch {
    return false;
  }
}

/** Adayları PARALEL yokla, ilk yanıtlayanı önbelleğe al. Aynı host için eşzamanlı çağrılar birleşir. */
function discoverMoonrakerPort(host: string, configured: number): Promise<number | null> {
  const running = portProbes.get(host);
  if (running) return running;
  const p = (async () => {
    try {
      const ports = candidatePorts(configured);
      const results = await Promise.all(ports.map(async (pt) => ({ pt, ok: await pingMoonrakerPort(host, pt) })));
      const hit = results.find((r) => r.ok);
      if (hit) {
        rememberPort(host, hit.pt);
        return hit.pt;
      }
      portProbeCooldown.set(host, Date.now() + PORT_PROBE_COOLDOWN_MS);
      return null;
    } finally {
      portProbes.delete(host);
    }
  })();
  portProbes.set(host, p);
  return p;
}

/**
 * İstek göndermeden önce kullanılacak port. Önbellek doluysa AĞA ÇIKMAZ.
 *
 * ⚠️ Keşif yapılamadığında `configured`'a DEĞİL, son çalıştığı bilinen porta düşülür.
 * Kayıtlı port sahada yanlış olabiliyor (bkz. `lastGoodPort`); ona dönmek 30 saniyelik
 * garanti-başarısız pencereler üretiyordu.
 */
export async function resolveMoonrakerPort(host: string, configured: number): Promise<number> {
  const known = portCache.get(host);
  if (known != null) return known;
  const enIyiTahmin = lastGoodPort.get(host) ?? configured;
  if ((portProbeCooldown.get(host) ?? 0) > Date.now()) return enIyiTahmin;
  return (await discoverMoonrakerPort(host, configured)) ?? enIyiTahmin;
}

/** Çözülmüş portla temel URL (birden çok istek yapan yerler için). */
async function moonrakerBaseFor(host: string, port: number): Promise<string> {
  return `http://${host}:${await resolveMoonrakerPort(host, port)}`;
}

/**
 * Moonraker isteği — port ÖNCE çözülür, sonra TEK istek gider (yedek port denemesi yalnız
 * çözümleme aşamasında ve yalnız port bilinmiyorken olur).
 */
async function mreq(
  host: string, port: number, path: string,
  init: RequestInit | undefined, timeoutMs: number,
): Promise<Response> {
  const p = await resolveMoonrakerPort(host, port);
  try {
    const res = await mfetch(`http://${host}:${p}${path}`, init, timeoutMs);
    notePortOk(host, p); // HTTP yanıtı geldiyse port doğru (durum kodu ne olursa olsun)
    return res;
  } catch (e) {
    notePortFailure(host, p);
    throw e;
  }
}

/** Yazıcının adresi değişti / yazıcı silindi → keşfedilen portu unut. */
export function clearMoonrakerPort(host?: string): void {
  // Adres/port GERÇEKTEN değiştiyse son-çalışan tahmini de geçersizdir.
  if (host) {
    portCache.delete(host);
    lastGoodPort.delete(host);
    portPersisted.delete(host);
    portFails.delete(host);
    portProbeCooldown.delete(host);
    return;
  }
  portCache.clear();
  lastGoodPort.clear();
  portPersisted.clear();
  portFails.clear();
  portProbeCooldown.clear();
}

function unwrap(json: any): any {
  return json && typeof json === "object" && "result" in json ? json.result : json;
}

/**
 * 3MF metadata'sındaki materyal dizgesi çok-kafalı baskıda kafa-başına birleşik gelir
 * ("PLA:PLA", "PLA;PETG;PLA"). Ayır → kırp → tekrarı kaldır. Hepsi aynıysa tek değer ("PLA"),
 * farklıysa "PLA · PETG". Boşsa null.
 */
function cleanFilamentType(s: unknown): string | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const uniq = [...new Set(s.split(/[;:,/|]+/).map((p) => p.trim()).filter(Boolean))];
  return uniq.length ? uniq.join(" · ") : null;
}

/** U1'in yapılandırılmış hata objesini (print_stats.exception: {id, code, message}) kullanıcı
 *  diline çevir — "neden durdu" artık tahmin değil (firmware exception_manager kodları). */
function exceptionText(exc: any): string | null {
  if (!exc || typeof exc !== "object") return null;
  const id = Number(exc.id);
  const code = Number(exc.code);
  const known =
    id === 523 && code === 0 ? "Filament bitti" :
    id === 523 && code === 38 ? "Filament dolandı / sıkıştı" :
    id === 523 && code === 39 ? "Slotun filament tipi tanımsız — yazıcı ekranından filamenti düzenle" :
    id === 531 && code === 14 ? "Nozzle çapı dosyayla uyuşmuyor" :
    id === 531 && code === 10 ? "Baskı dosyası okunamadı" :
    id === 525 ? "Filament besleme sorunu" :
    id === 526 ? "Tabla sorunu" :
    null;
  const raw = typeof exc.message === "string" && exc.message.trim() ? exc.message.trim() : null;
  if (known) return raw && !known.includes(raw) ? `${known}` : known;
  return raw;
}

/**
 * Ham Moonraker `status` gövdesini karta çevirir.
 * DIŞA AÇIK: kalıcı WebSocket bağlantısı da aynı gövdeyi getiriyor ve aynı yorumdan geçmeli —
 * iki ayrı ayrıştırıcı olsaydı iki yol farklı sonuç üretirdi.
 */
export function parseStatus(status: any): MoonrakerStatus {
  const ps = status.print_stats ?? {};
  const vs = status.virtual_sdcard ?? {};
  const ds = status.display_status ?? {};
  // Tool-changer (Snapmaker U1): AKTİF kafanın sıcaklığını göster. toolhead.extruder aktif
  // ekstruderin adını verir ("extruder", "extruder1"...). Boştaki kafa 0'ı göstermeyiz.
  const th = status.toolhead ?? {};
  const activeExName = typeof th.extruder === "string" && th.extruder ? th.extruder : "extruder";
  const ex =
    (status[activeExName] && typeof status[activeExName] === "object"
      ? status[activeExName]
      : status.extruder) ?? {};
  // Dört kafanın HEPSİ okunur: U1'de boştaki kafalar da ısıtılıp soğuyor, panelde tek sayı
  // görünce hangisinin sıcak kaldığı bilinmiyordu. Yanıtta olmayan kafa listeye girmez.
  const nozzles: NozzleTemp[] = [];
  for (let i = 0; i < 4; i++) {
    const key = i === 0 ? "extruder" : `extruder${i}`;
    const e = status[key];
    if (!e || typeof e !== "object" || typeof e.temperature !== "number") continue;
    nozzles.push({
      index: i,
      temp: Math.round(e.temperature),
      target: Math.round(e.target ?? 0),
      active: key === activeExName,
    });
  }
  const eo = status.exclude_object ?? {};
  const hb = status.heater_bed ?? {};
  const gm = status.gcode_move ?? {};
  // İLERLEME KAYNAĞI: ÖNCE M73 (display_status), SONRA bayt oranı (virtual_sdcard).
  // Canlı ölçüm (U1, 12 Ağu): bayt %17.6 iken M73 %24 — bayt oranı ZAMAN değil KONUM ölçer,
  // yavaş katmanlar az bayt/çok zaman harcadığı için kalan süre saatlerce şişiyordu.
  const slicerProgress = typeof ds.progress === "number" ? ds.progress : null;
  const byteProgress = typeof vs.progress === "number" ? vs.progress : null;
  const picked = pickProgress({ slicerProgress, byteProgress });
  const pos = Array.isArray(gm.gcode_position) ? gm.gcode_position : [];
  const axis = (i: number) => (typeof pos[i] === "number" ? (pos[i] as number) : null);
  const zPos = axis(2);
  const speedFactor = typeof gm.speed_factor === "number" ? gm.speed_factor : null;
  return {
    online: true,
    state: (ps.state as MoonrakerState) || "standby",
    // Neden: düz mesaj yoksa U1'in yapılandırılmış exception'ından üret (filament bitti/dolandı/
    // slot tanımsız/nozzle uyumsuz — panelde ve telefonda net görünür).
    message:
      (typeof ps.message === "string" && ps.message.trim() ? ps.message.trim() : null) ??
      exceptionText(ps.exception),
    filename: ps.filename || null,
    progress: picked.progress,
    progressSource: picked.source,
    slicerProgress,
    byteProgress,
    filePosition: typeof vs.file_position === "number" ? vs.file_position : null,
    fileSize: typeof vs.file_size === "number" ? vs.file_size : null,
    printDurationSec: typeof ps.print_duration === "number" ? ps.print_duration : 0,
    currentLayer: typeof ps.info?.current_layer === "number" ? ps.info.current_layer : null,
    totalLayer: typeof ps.info?.total_layer === "number" ? ps.info.total_layer : null,
    zHeight: zPos,
    posX: axis(0),
    posY: axis(1),
    speedPercent: speedFactor != null && speedFactor > 0 ? Math.round(speedFactor * 100) : null,
    nozzle: Math.round(ex.temperature ?? 0),
    nozzleTarget: Math.round(ex.target ?? 0),
    nozzles,
    bed: Math.round(hb.temperature ?? 0),
    bedTarget: Math.round(hb.target ?? 0),
    currentObject: typeof eo.current_object === "string" && eo.current_object ? eo.current_object : null,
    excludedObjects: Array.isArray(eo.excluded_objects)
      ? eo.excluded_objects.filter((x: unknown): x is string => typeof x === "string")
      : [],
  };
}

async function tryStatusAt(host: string, port: number, butceMs = 4000): Promise<MoonrakerStatus | null> {
  try {
    /**
     * ⚠️ 1500 DEĞİL. Eski yorum "sağlıklı LAN yazıcısı <500 ms yanıt verir" diyordu; gerçek
     * ölçüm (baskı sürerken, 20 Ağu 2026): Pro p50 210-256 ms / p99 ~298 ms, ama Plus
     * p50 193-269 ms / **p99 514-609 ms**. Üstüne Plus'ta bağlantıların %3,3'ü SYN kaybına
     * düşüp sabit +1000 ms ekliyor → ~1250 ms, 1500 ms bütçeye karşı yalnız 250 ms pay.
     * Yani sağlıklı bir yazıcı, yavaş bir ana yüzünden "çevrimdışı" sayılıyordu.
     * 4000 ms hâlâ çevrimdışı yazıcıyı hızlı eler ama yavaş cevabı kopma saymaz.
     */
    const res = await mfetch(`http://${host}:${port}/printer/objects/query?${QUERY}`, undefined, butceMs);
    if (!res.ok) return null;
    const status = unwrap(await res.json())?.status;
    if (!status) return null;
    return parseStatus(status);
  } catch {
    return null;
  }
}

export async function fetchMoonrakerStatus(host: string, port: number): Promise<MoonrakerStatus> {
  const offline: MoonrakerStatus = {
    online: false, state: "standby", message: null, filename: null,
    progress: 0, progressSource: "none", slicerProgress: null, byteProgress: null,
    filePosition: null, fileSize: null, printDurationSec: 0,
    currentLayer: null, totalLayer: null, zHeight: null, posX: null, posY: null,
    speedPercent: null, nozzle: 0, nozzleTarget: 0, nozzles: [], bed: 0, bedTarget: 0,
    currentObject: null, excludedObjects: [],
  };
  const cached = portCache.get(host);
  // Bilinen çalışan port varsa SADECE onu dene — cihazın Moonraker portu sabittir (Elegoo 80, U1 7125).
  // Başarısızsa yazıcı ÇEVRİMDIŞIDIR; tüm adayları yeniden taramak (3×timeout = ~4.5sn) ana-süreci
  // boşuna kilitliyordu. Artık çevrimdışı yazıcı tek timeout'ta (~1.5sn) çözülür. Port gerçekten
  // değişmişse "Bağlantıyı Test Et" (testMoonraker) yeniden keşfedip önbelleği günceller.
  if (cached != null) {
    // TEK DENEME YETMEZ: portu ZATEN biliyoruz, yani yazıcı daha önce cevap vermişti. Tek bir
    // düşen/geciken yanıt (kablosuz parazit, yazıcı baskı sırasında meşgul, ana süreç kısa süre
    // bloke) kartı "Bağlantı yok"a düşürüyordu — üstelik status-cache çevrimdışıyı 30sn
    // önbelleklediği için hata 30 saniye ekranda kalıyordu. İkinci bir deneme bu sınıf sahte
    // çevrimdışıyı ucuza eler (gerçekten kapalı yazıcıda maliyet 30sn'de bir ~1.5sn fazladan).
    /**
     * İKİNCİ DENEME KISA BÜTÇELİ. Eskiden ikisi de 4000 ms bütçe ödüyordu ve SIRALI
     * çalıştığı için gerçekten kapalı bir yazıcı paneli 8 saniye bekletiyordu (ölçüldü:
     * cevap vermeyen LAN adresine istek 4008/4007 ms'de düşüyor — hızlı ARP/ICMP reddi yok).
     * İkinci denemenin işi "tek düşen yanıtı elemek"; o iş 1500 ms'de görülür. BİRİNCİ
     * denemenin 4000 ms'i ölçüme dayalı, dokunulmadı (bkz. yukarıdaki not).
     */
    const st = (await tryStatusAt(host, cached)) ?? (await tryStatusAt(host, cached, 1500));
    if (st) notePortOk(host, cached);
    else notePortFailure(host, cached); // üst üste düşerse port unutulur → yeniden keşif
    return st ?? offline;
  }
  // Yazıcı az önce hiçbir portta yanıt vermedi → tüm adayları yeniden taramak boşuna; yalnız
  // kayıtlı portu dene (tarama yasağı bitince keşif kendiliğinden tekrar açılır).
  if ((portProbeCooldown.get(host) ?? 0) > Date.now()) {
    const st = await tryStatusAt(host, port);
    if (st) rememberPort(host, port);
    return st ?? offline;
  }
  // İlk keşif (port bilinmiyor): adayları PARALEL yokla — çevrimdışıysa sıralı 3×timeout yerine 1×.
  // Durum sorgusu hem portu bulur hem veriyi getirir → keşif için ek gidiş-dönüş YOK.
  const results = await Promise.all(
    candidatePorts(port).map(async (p) => ({ p, st: await tryStatusAt(host, p) }))
  );
  const hit = results.find((r) => r.st);
  if (hit && hit.st) {
    rememberPort(host, hit.p);
    return hit.st;
  }
  portProbeCooldown.set(host, Date.now() + PORT_PROBE_COOLDOWN_MS);
  return offline;
}

export async function fetchMoonrakerMeta(host: string, port: number, filename: string): Promise<MoonrakerMeta | null> {
  try {
    const res = await mreq(
      host, port,
      `/server/files/metadata?filename=${encodeURIComponent(filename)}`,
      undefined,
      3000
    );
    if (!res.ok) return null;
    const r = unwrap(await res.json());
    if (!r) return null;
    const thumbs = Array.isArray(r.thumbnails) ? [...r.thumbnails] : [];
    thumbs.sort((a: any, b: any) => (b.width * b.height) - (a.width * a.height));
    const meta: MoonrakerMeta = {
      estimatedTimeSec: typeof r.estimated_time === "number" ? r.estimated_time : null,
      thumbnailRelPath: thumbs[0]?.relative_path ?? null,
      thumbnailDataUrl: null,
      filamentType: cleanFilamentType(r.filament_type),
      filamentColours: parseMetadataColours(r.filament_colour),
      filamentGrams: typeof r.filament_weight_total === "number" ? Math.round(r.filament_weight_total * 100) / 100 : null,
      totalLayer: typeof r.layer_count === "number" ? r.layer_count : null,
      layerHeight: typeof r.layer_height === "number" ? r.layer_height : null,
      firstLayerHeight: typeof r.first_layer_height === "number" ? r.first_layer_height : null,
    };
    // FALLBACK (Elegoo Neptune canlı tanılamayla doğrulandı): bu Moonraker sürümü Orca gcode'unu
    // HİÇ TARAMIYOR → metadata yalnız `size/modified/filename` döner. Katman, SÜRE TAHMİNİ,
    // KÜÇÜK RESİM ve filament rengi dosyanın kendisinde var. Dosyanın baş (küçük resimler) +
    // son (süre/renk/katman) kısmını TEK Range çiftiyle çekip hepsini AYNI yanıttan çıkarırız.
    const needsGcodeScan =
      meta.totalLayer == null || meta.layerHeight == null ||
      meta.estimatedTimeSec == null || (meta.thumbnailRelPath == null);
    if (needsGcodeScan && typeof r.size === "number" && r.size > 0) {
      const g = await fetchGcodeLayerMeta(host, port, filename, r.size).catch(() => null);
      if (g) {
        meta.totalLayer = meta.totalLayer ?? g.totalLayer;
        meta.layerHeight = meta.layerHeight ?? g.layerHeight;
        meta.firstLayerHeight = meta.firstLayerHeight ?? g.firstLayerHeight;
        meta.estimatedTimeSec = meta.estimatedTimeSec ?? g.estimatedTimeSec;
        meta.filamentGrams = meta.filamentGrams ?? g.filamentGrams;
        meta.thumbnailDataUrl = meta.thumbnailDataUrl ?? g.thumbnailDataUrl;
        if (!meta.filamentColours.length) meta.filamentColours = g.filamentColours;
        if (!meta.filamentType) meta.filamentType = cleanFilamentType(g.filamentTypeRaw);
      }
    }
    return meta;
  } catch {
    return null;
  }
}

/** Metadata'daki `filament_colour` ("#000000;#FFFFFF") → hex dizisi. */
function parseMetadataColours(v: unknown): string[] {
  if (typeof v !== "string" || !v.trim()) return [];
  return v
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter((p) => /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(p))
    .map((p) => `#${(p.startsWith("#") ? p.slice(1) : p).slice(0, 6).toUpperCase()}`);
}

/**
 * Küçük resim bloğu gcode'un İLK kısmındadır ama 800x800 base64 tek başına ~130 KB tutar
 * (canlı ölçüm: Elegoo dosyasında 320x320 + 800x800 iki blok, ikincisi ~200 KB'da biter).
 * 256 KB tek Range isteğiyle hepsi gelir; katman/süre/renk zaten AYNI çağrının son parçasından
 * okunuyor → toplam ağ maliyeti dosya başına iki istek, baskı boyunca bir kez (meta önbelleği).
 */
const GCODE_HEAD_BYTES = 262_144;

interface GcodeScan {
  totalLayer: number | null;
  layerHeight: number | null;
  firstLayerHeight: number | null;
  estimatedTimeSec: number | null;
  thumbnailDataUrl: string | null;
  filamentColours: string[];
  filamentTypeRaw: string | null;
  filamentGrams: number | null;
}

/** Moonraker gcode dosyasının baş+son kısmını (Range) çekip dilimleyicinin YAZDIĞI ama
 *  Moonraker'ın OKUMADIĞI her şeyi parse et. Orca formatı canlı doğrulandı. */
async function fetchGcodeLayerMeta(
  host: string, port: number, filename: string, size: number,
): Promise<GcodeScan> {
  const enc = filename.split("/").map(encodeURIComponent).join("/");
  const path = `/server/files/gcodes/${enc}`;
  const range = async (r: string, timeoutMs: number): Promise<string> => {
    const res = await mreq(host, port, path, { headers: { Range: r } }, timeoutMs);
    if (res.status !== 206 && !res.ok) return "";
    return res.text();
  };
  const headEnd = Math.min(GCODE_HEAD_BYTES, Math.max(16_000, size)) - 1;
  const head = await range(`bytes=0-${headEnd}`, 9000);
  // Altbilgi yalnız baş parçanın DIŞINDA kalan bir kuyruk varsa istenir. Eski koşul (`size > 24000`)
  // 24-40 KB'lık küçük dosyalarda NEGATİF başlangıç üretiyordu ("bytes=-10000-…"): sunucu ya 416
  // ile reddediyor (süre/renk/gram sessizce bilinmez kalıyor) ya da tüm dosyayı ikinci kez
  // gönderip metni çiftliyordu.
  const tailStart = Math.max(0, size - 40_000);
  const tail = size > 0 && tailStart > headEnd ? await range(`bytes=${tailStart}-${size - 1}`, 5000) : "";
  const text = `${head}\n${tail}`;

  const tl = /;\s*total layer(?:s)?\s+(?:number|count)\s*[:=]\s*(\d+)/i.exec(text);
  const totalLayer = tl ? Number(tl[1]) : null;

  let layerHeight: number | null = null;
  const lh = /;\s*layer_height\s*[:=]\s*([\d.]+)/i.exec(text);
  if (lh) layerHeight = parseFloat(lh[1]);
  if (!(layerHeight && layerHeight > 0)) {
    const h = /;\s*HEIGHT\s*:\s*([\d.]+)/i.exec(text); // Orca ;HEIGHT:0.2 (katman yüksekliği)
    if (h) layerHeight = parseFloat(h[1]);
  }

  let firstLayerHeight: number | null = null;
  const flh = /;\s*(?:initial_layer_print_height|first_layer_height|initial_layer_height)\s*[:=]\s*([\d.]+)/i.exec(text);
  if (flh) firstLayerHeight = parseFloat(flh[1]);

  // Küçük resim YALNIZ baş parçadan aranır (son parçada yarım blok kalıntısı olabilir).
  const best = pickLargestThumbnail(parseGcodeThumbnails(head));
  const ftRaw = /^;\s*filament_type\s*=\s*(.+)$/im.exec(text);

  return {
    totalLayer: totalLayer && totalLayer > 0 ? totalLayer : null,
    layerHeight: layerHeight && layerHeight > 0 ? Math.round(layerHeight * 1000) / 1000 : null,
    firstLayerHeight: firstLayerHeight && firstLayerHeight > 0 ? firstLayerHeight : null,
    estimatedTimeSec: parseGcodeEstimatedTimeSec(text),
    thumbnailDataUrl: best ? thumbnailDataUrl(best) : null,
    filamentColours: parseGcodeFilamentColours(text),
    filamentTypeRaw: ftRaw ? ftRaw[1].trim() : null,
    filamentGrams: parseGcodeFilamentGrams(text),
  };
}

/** Thumbnail relative_path metadata'da gcode dosyasının klasörüne görelidir. */
export function moonrakerThumbUrl(host: string, port: number, filename: string, relPath: string): string {
  const dir = filename.includes("/") ? filename.slice(0, filename.lastIndexOf("/")) : "";
  const full = dir ? `${dir}/${relPath}` : relPath;
  const encoded = full.split("/").map(encodeURIComponent).join("/");
  return `${moonrakerBase(host, port)}/server/files/gcodes/${encoded}`;
}

// ── Kontrol komutları: zaman aşımı, doğrulama, sade Türkçe hata ─────────────────────────────
//
// ESKİ DAVRANIŞ (hata): tüm komutlar 6 saniyelik tek zaman aşımıyla gönderiliyordu. Klipper'da
// PAUSE/RESUME/CANCEL istek DÖNMEDEN ÖNCE makroyu çalıştırır (nozulü kaldır, filamenti geri çek,
// tablayı park et) — U1'de bu 10 saniyeyi rahat aşıyor. Fetch iptal ediliyor, kullanıcıya ham
// İngilizce "This operation was aborted" düşüyor, oysa komut yazıcıda ÇALIŞMIŞ oluyordu.
// Artık: komut türüne göre zaman aşımı + sonucu DURUMDAN doğrulama.

/** Durum sorgusu kısa; kontrol komutu uzun (makro çalışması dahil). */
const CONTROL_TIMEOUT_MS: Record<ControlAction, number> = {
  pause: 30_000,
  resume: 30_000,
  cancel: 45_000,
};
/** Komut sonrası durumun beklenen değere geçmesi için tanınan süre. */
const VERIFY_WINDOW_MS: Record<ControlAction, number> = {
  pause: 12_000,
  resume: 12_000,
  cancel: 20_000,
};
const VERIFY_POLL_MS = 500;

export type ControlAction = "pause" | "resume" | "cancel";

const ACTION_LABEL: Record<ControlAction, string> = {
  pause: "Duraklatma",
  resume: "Devam ettirme",
  cancel: "İptal",
};

/** Komuttan sonra yazıcının olması gereken durumlar. */
const EXPECTED_STATES: Record<ControlAction, MoonrakerState[]> = {
  pause: ["paused"],
  resume: ["printing"],
  cancel: ["standby", "cancelled", "complete"],
};

/**
 * Komut GÖNDERİLMEDEN ÖNCE yazıcının olması gereken durumlar.
 *
 * NEDEN: doğrulama yalnız "durum beklenen değerde mi" diye bakıyordu ve komut ÖNCESİ durumu
 * doğrulama sayıyordu. Boştaki yazıcıda "İptal"e basmak Klipper'dan 400 alıyor, ardından
 * okunan "standby" beklenen listede olduğu için arayüz "İptal edildi" diyordu — hiçbir baskı
 * iptal edilmemişken. Aynı sahte başarı duraklamış yazıcıda "Duraklat", basan yazıcıda "Devam"
 * için de üretiliyordu.
 */
const REQUIRED_STATES: Record<ControlAction, MoonrakerState[]> = {
  pause: ["printing"],
  resume: ["paused"],
  cancel: ["printing", "paused"],
};

const NOT_APPLICABLE_TEXT: Record<ControlAction, string> = {
  pause: "Duraklatma yapılamadı — yazıcı şu an basmıyor.",
  resume: "Devam ettirme yapılamadı — duraklatılmış bir baskı yok.",
  cancel: "İptal yapılamadı — süren bir baskı yok.",
};

/** Ham ağ/HTTP hatasını SADE TÜRKÇE'ye çevir — İngilizce metin kullanıcıya ASLA gitmez. */
export function moonrakerErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  if (/abort/i.test(raw)) return "Yazıcı zamanında yanıt vermedi";
  if (/ECONNREFUSED|refused/i.test(raw)) return "Yazıcı bağlantıyı reddetti";
  if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(raw)) return "Yazıcıya ağdan ulaşılamadı";
  if (/ETIMEDOUT|timed? ?out/i.test(raw)) return "Yazıcı yanıt vermiyor";
  if (/ECONNRESET|socket hang up|EPIPE/i.test(raw)) return "Yazıcıyla bağlantı kesildi";
  return "Yazıcıya bağlanılamadı";
}

/** Beklenen duruma geçene kadar kısa aralıklarla durumu oku. */
async function waitForState(
  host: string, port: number, expected: MoonrakerState[], windowMs: number,
): Promise<MoonrakerState | null> {
  const deadline = Date.now() + windowMs;
  let last: MoonrakerState | null = null;
  for (;;) {
    const st = await fetchMoonrakerStatus(host, port);
    if (st.online) {
      last = st.state;
      if (expected.includes(st.state)) return st.state;
    }
    if (Date.now() >= deadline) return last && expected.includes(last) ? last : null;
    await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
  }
}

export interface ControlResult {
  /** Komut sonrası durum yazıcıdan DOĞRULANDI mı. */
  verified: boolean;
  /** Doğrulama sonrası okunan durum (okunamadıysa null). */
  state: MoonrakerState | null;
}

/**
 * Duraklat / devam / iptal — gönder ve SONUCU DURUMDAN DOĞRULA.
 * HTTP hatası alsak bile durum beklenen değere geçtiyse komut BAŞARILIDIR (zaman aşımına uğrayan
 * istek, yazıcıda çalışmış komutu geri almaz). Durum geçmediyse net Türkçe hata fırlatılır.
 */
export async function moonrakerControl(
  host: string, port: number, action: ControlAction,
): Promise<ControlResult> {
  // ÖN KOŞUL: yazıcı gerçekten bu komutu alabilecek durumda mı. Bu okuma olmadan komut ÖNCESİ
  // durum "doğrulanmış" sayılıyor ve olmamış bir iptal/duraklatma başarılı raporlanıyordu.
  const before = await fetchMoonrakerStatus(host, port);
  if (!before.online) throw new Error(`${ACTION_LABEL[action]} yapılamadı — yazıcıya ulaşılamıyor.`);
  if (!REQUIRED_STATES[action].includes(before.state)) throw new Error(NOT_APPLICABLE_TEXT[action]);

  let failure: string | null = null;
  try {
    const res = await mreq(
      host, port,
      `/printer/print/${action}`,
      { method: "POST" },
      CONTROL_TIMEOUT_MS[action],
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[moonraker] ${action} HTTP ${res.status} ${body.slice(0, 200)}`);
      failure =
        res.status === 400 || res.status === 409
          ? `${ACTION_LABEL[action]} şu an yapılamıyor — yazıcı bu durumda değil.`
          : `${ACTION_LABEL[action]} komutu yazıcıya iletilemedi.`;
    }
  } catch (e) {
    console.warn(`[moonraker] ${action} istek hatası:`, e);
    failure = `${ACTION_LABEL[action]} komutu gönderilirken sorun oldu (${moonrakerErrorText(e)}).`;
  }

  // İstek başarısız OLDU ve yazıcı gerçekten ulaşılamıyorsa 12-20 saniye boşuna bekleme:
  // hatayı hemen söyle (kullanıcı "bir şey oluyor mu?" diye bakakalmasın).
  if (failure) {
    const probe = await fetchMoonrakerStatus(host, port);
    if (!probe.online) throw new Error(`${ACTION_LABEL[action]} yapılamadı — yazıcıya ulaşılamıyor.`);
    if (EXPECTED_STATES[action].includes(probe.state)) return { verified: true, state: probe.state };
  }

  const state = await waitForState(host, port, EXPECTED_STATES[action], VERIFY_WINDOW_MS[action]);
  if (state) return { verified: true, state };
  if (failure) throw new Error(failure);
  throw new Error(`${ACTION_LABEL[action]} komutu gönderildi ama yazıcı durumu değişmedi — ekranını kontrol et.`);
}

/** Baskı başlatmadan önce yazıcının BOŞTA olduğunu doğrula (meşgulse net hata). Eski akış bu
 *  kontrol olmadan upload(print=true) gönderiyordu → Moonraker dosyayı alır ama BASMAZ,
 *  print_started:false döner ve kullanıcı sahte "Başlatıldı 🎉" görürdü. */
async function assertMoonrakerIdle(host: string, port: number): Promise<void> {
  const st = await fetchMoonrakerStatus(host, port);
  if (!st.online) throw new Error("Yazıcıya ulaşılamadı — açık ve ağda mı?");
  if (st.state === "printing" || st.state === "paused") {
    throw new Error("Yazıcı şu an meşgul — önce mevcut baskıyı bitir veya iptal et.");
  }
}

export async function moonrakerStart(host: string, port: number, filename: string): Promise<void> {
  const res = await mreq(
    host, port,
    `/printer/print/start?filename=${encodeURIComponent(filename)}`,
    { method: "POST" },
    8000
  );
  if (!res.ok) throw new Error(`Baskı başlatılamadı (HTTP ${res.status})`);
}

/**
 * Yazıcıda ZATEN duran bir dosyayı başlat — marka-doğru yol.
 * Snapmaker U1: düz /printer/print/start `print_task_config`'i DOLDURMAZ → filament_type=='NONE'
 * → sahte runout (id=523 code=39), nozzle ısınmaz. Metadata yazıcıdan okunur ve
 * SDCARD_PRINT_FILE_WITH_PARAMETERS ile native başlatılır (uploadAndPrint'teki akışın aynısı).
 * Diğer Moonraker (Elegoo): düz start yeterli. Her iki yol da önce boşta-kontrolü yapar.
 */
export async function moonrakerStartExisting(host: string, port: number, filename: string, brand?: string, prefs?: MoonrakerPrefs, headMapping?: number[]): Promise<void> {
  await assertMoonrakerIdle(host, port);
  if ((brand || "").toLowerCase() === "snapmaker") {
    const meta = await moonrakerRawMeta(host, port, filename);
    // prefs geçirilir (eskiden hep 0'a zorlanıyordu); MAP_TABLE her başlatmada gönderilir
    // (identity ya da SlotStep'ten gelen kafa eşlemesi) → bayat tablo bu baskıyı etkileyemez.
    let toolMap: Record<number, number> | undefined;
    if (headMapping && headMapping.length) {
      const tm: Record<number, number> = {};
      headMapping.forEach((head, idx) => { if (typeof head === "number" && head >= 0) tm[idx] = head; });
      if (Object.keys(tm).length) toolMap = tm;
    }
    await moonrakerGcodeScript(host, port, buildSnapmakerStartScript(filename, meta, prefs, toolMap));
    return;
  }
  await moonrakerStart(host, port, filename);
}

/** Yazıcıdaki dosyanın boyutu (metadata üzerinden) — yoksa null. Reuse kimlik doğrulaması için. */
export async function moonrakerFileSize(host: string, port: number, filename: string): Promise<number | null> {
  try {
    const res = await mreq(
      host, port,
      `/server/files/metadata?filename=${encodeURIComponent(filename)}`,
      undefined, 5000
    );
    if (!res.ok) return null;
    const m = unwrap(await res.json());
    const n = Number((m as any)?.size);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export interface MoonrakerStorage {
  total: number | null;
  free: number | null;
  used: number | null;
  files: { name: string; size: number; modified: number | null }[];
}

/** Depolama durumu: gcodes kökü dosya listesi + disk kullanım (Moonraker directory API). */
export async function moonrakerStorage(host: string, port: number): Promise<MoonrakerStorage> {
  const res = await mreq(
    host, port,
    `/server/files/directory?path=gcodes&extended=false`,
    undefined, 8000
  );
  if (!res.ok) throw new Error(`Depolama bilgisi alınamadı (HTTP ${res.status})`);
  const j = unwrap(await res.json()) as any;
  const du = j?.disk_usage ?? {};
  const files = (Array.isArray(j?.files) ? j.files : [])
    .map((f: any) => ({
      name: String(f?.filename ?? f?.path ?? ""),
      size: Number(f?.size) || 0,
      modified: Number.isFinite(Number(f?.modified)) ? Number(f.modified) : null,
    }))
    .filter((f: { name: string }) => !!f.name)
    .sort((a: { size: number }, b: { size: number }) => b.size - a.size);
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return { total: num(du.total), free: num(du.free), used: num(du.used), files };
}

/** gcodes kökünden dosya sil. Silinen sayısını döndürür (tek tek; biri hata verirse devam). */
export async function moonrakerDeleteFiles(host: string, port: number, names: string[]): Promise<number> {
  let ok = 0;
  for (const n of names) {
    if (!n || n.includes("..")) continue;
    try {
      const res = await mreq(
        host, port,
        `/server/files/gcodes/${encodeURIComponent(n)}`,
        { method: "DELETE" }, 10000
      );
      if (res.ok) ok++;
    } catch { /* sıradakine geç */ }
  }
  return ok;
}

/**
 * Snapmaker U1 (tool-changer) gcode'unda tool/kafa atamasını yeniden eşle.
 * toolMap[dilimleyici_filament_index] = fiziksel kafa (0-tabanlı). U1'de besleme kanalı kafaya
 * SABİT bağlıdır (firmware config) — gcode'da kanal komutu yoktur; kafa doğru eşlenirse kanal da doğrudur.
 *
 * GERÇEK U1 profili (Orca fdm_U1) doğrulandı — eski regex'lerin KAÇIRDIĞI iki kritik satır tipi:
 *   1) `T1; pick the tool` — kafa seçimi SATIR SONU YORUMLU gelir; eski `^T\d+$` deseni bunu
 *      yakalamıyordu → M109 remap'lenip fiziksel kafa seçimi ORİJİNAL kalıyor, baskı yanlış
 *      kafadan/kanaldan yürüyordu ("4. slottan çek dedim, 2'den çekti" bug'ı).
 *   2) `PRINT_START TOOL_TEMP=.. T0_TEMP=.. T1_TEMP=.. TOOL=<n>` — makro, kafa hazırlığını bu
 *      parametrelerle yapar; TOOL değeri ve T<n>_TEMP anahtarları da eşlenmeli.
 * G-hareketleri / fan / düz yorum satırları DOKUNULMAZ. Identity (i→i) ise metin aynen döner.
 */
export function remapMoonrakerTools(text: string, toolMap: Record<number, number>): string {
  const keys = Object.keys(toolMap).map(Number);
  if (!keys.length || keys.every((k) => toolMap[k] === k)) return text; // identity → değişiklik yok
  const mapT = (m: string, d: string) => {
    const n = Number(d);
    return n in toolMap ? `T${toolMap[n]}` : m;
  };
  let tSelect = 0, mTemp = 0, printStart = 0; // tanılama sayaçları
  const out = text.split("\n").map((line) => {
    const t = line.trimStart();
    // 1) Kafa seçimi: satır `T<n>` ile başlıyorsa (sonu boşluk/;yorum/satır-sonu) İLK token eşlenir.
    if (/^T\d+(?=[\s;]|$)/.test(t)) {
      tSelect++;
      return line.replace(/\bT(\d+)\b/, mapT); // yalnız baştaki token (yorumdaki metne dokunma)
    }
    // 2) Sıcaklık komutları: M104/M109/M108 ... T<n>
    if (/^M(?:104|109|108)\b/.test(t)) {
      mTemp++;
      return line.replace(/\bT(\d+)\b/g, mapT);
    }
    // 3) PRINT_START makrosu: TOOL=<n> değeri + T<n>_TEMP= anahtar adları eşlenir.
    if (/^PRINT_START\b/i.test(t)) {
      printStart++;
      return line
        .replace(/\bTOOL\s*=\s*(\d+)\b/i, (m, d) => {
          const n = Number(d);
          return n in toolMap ? `TOOL=${toolMap[n]}` : m;
        })
        .replace(/\bT(\d+)_TEMP\s*=/gi, (m, d) => {
          const n = Number(d);
          return n in toolMap ? `T${toolMap[n]}_TEMP=` : m;
        });
    }
    return line;
  }).join("\n");
  // Tanılama: eşleme istendi ama hiçbir kafa-seçim/başlangıç satırı bulunamadıysa bir daha
  // aynı hatayı KANITSIZ aramayalım — log'a düşür (kullanıcıya değil).
  console.log(`[moonraker] tool remap ${JSON.stringify(toolMap)} → T-seçim:${tSelect} M10x:${mTemp} PRINT_START:${printStart}`);
  if (tSelect === 0 && printStart === 0) {
    console.warn("[moonraker] UYARI: remap istendi ama gcode'da kafa-seçim satırı bulunamadı — dosya farklı bir başlangıç makrosu kullanıyor olabilir");
  }
  return out;
}

export interface MoonrakerPrefs { timelapse?: boolean; bedLeveling?: boolean; flowCali?: boolean }

/** POST /printer/gcode/script — keyfi komut (Snapmaker gelişmiş başlatma, ışık, hız…).
 *  Hata metni SADE TÜRKÇE; yazıcının ham İngilizce yanıtı yalnız log'a düşer. */
async function moonrakerGcodeScript(
  host: string,
  port: number,
  script: string,
  opts: { timeoutMs?: number; failMessage?: string } = {},
): Promise<void> {
  const failMessage = opts.failMessage ?? "Baskı başlatılamadı.";
  // Script GÖVDEDE (JSON) gönderilir — MAP_TABLE + metadata ile büyüyen komut, query-string'in
  // header sınırlarına takılmasın.
  let res: Response;
  try {
    res = await mreq(
      host, port,
      `/printer/gcode/script`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ script }) },
      opts.timeoutMs ?? 30000
    );
  } catch (e) {
    console.warn(`[moonraker] gcode script hatası (${script.slice(0, 60)}):`, e);
    throw new Error(`${failMessage} (${moonrakerErrorText(e)})`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.warn(`[moonraker] gcode script HTTP ${res.status}: ${t.slice(0, 200)}`);
    throw new Error(failMessage);
  }
}

/** Ham Moonraker metadata — Snapmaker WITH_PARAMETERS alanları için. Yükleme sonrası tarama
 *  gecikebilir → filament_type gelene kadar kısa poll. */
async function moonrakerRawMeta(host: string, port: number, filename: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 8; i++) {
    try {
      const res = await mreq(
        host, port,
        `/server/files/metadata?filename=${encodeURIComponent(filename)}`,
        undefined, 6000
      );
      if (res.ok) {
        const m = unwrap(await res.json());
        if (m && typeof m === "object" && ((m as any).filament_type != null || i >= 4)) return m as Record<string, unknown>;
      }
    } catch { /* tekrar dene */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return {};
}

/** Yedek: gcode başlığından `; filament_type = PLA;PLA` çek (metadata taraması yetişmezse). */
function filamentTypeFromGcode(buf: Buffer): string | null {
  const head = buf.subarray(0, 4096).toString("latin1");
  const tail = buf.subarray(Math.max(0, buf.length - 8192)).toString("latin1");
  const re = /^;\s*filament_type\s*=\s*(.+)$/im;
  const m = re.exec(head) || re.exec(tail);
  return m ? m[1].trim() : null;
}

const SM_META_FIELDS = [
  "line_width", "layer_height", "outer_wall_speed", "nozzle_diameter_list", "nozzle_temp",
  "filament_type", "filament_flow_ratio", "filament_diameter", "filament_max_vol_speed",
  "filament_used_g", "filament_used_mm",
];
function pyRepr(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map((x) => (typeof x === "string" ? `'${x}'` : String(x))).join(", ") + "]";
  return String(v);
}

/**
 * Snapmaker U1 native baskı komutu — moonraker `start_print_advanced` + `_fill_metadata` BİREBİR replikası.
 * KRİTİK: `SDCARD_PRINT_FILE_WITH_PARAMETERS` önce `SET_PRINT_TASK_PARAMETERS` çalıştırıp `print_task_config`'i
 * (özellikle her kafanın `filament_type`'ını gcode başlığından) doldurur. Düz `SDCARD_PRINT_FILE` bunu YAPMAZ →
 * `filament_type=='NONE'` → preamble'daki `SM_PRINT_FLOW_CALIBRATE`/filament kontrolü `id=523,code=39` "not edit
 * filament" PAUSE → SAHTE runout, nozzle ısınmaz. (Kaynak: u1-moonraker klippy_apis.py, u1-klipper print_task_config.py.)
 * Calibration tercihleri DEFAULT 0/OFF — native preference (gcode'a dokunmadan; `flow_calibrate==0` makroyu
 * zararsızca erken döndürür, priming'i BOZMAZ).
 */
/**
 * MAP_TABLE çiftleri — `[mantıksal araç, fiziksel kafa]`.
 *
 * ⚠️ MANTIKSAL İNDEKS 4'TEN BÜYÜK OLABİLİR. Eskiden burada sabit `[0,1,2,3]` döngüsü vardı ve
 * dilimleyici projesinde 4'ten fazla filament tanımlıysa (Orca'da çok yaygın) 4 ve üstü
 * mantıksal araçlar tabloya HİÇ girmiyordu: kullanıcının o renk için seçtiği kafa sessizce
 * düşüyor, firmware varsayılanda kalıyor ve o renk YANLIŞ KAFADAN basılıyordu.
 *
 * Sahadan alınan kanıt (aynı dosya, 5 filamentli proje, kullanılan araçlar 0/1/3/4):
 *   bizim eski çıktı : [[0, 0], [1, 2], [2, 2], [3, 3]]     ← 4 YOK, kullanılmayan 2 var
 *   Snapmaker uygul. : [[0, 0], [1, 2], [3, 3], [4, 1]]     ← doğrusu
 * Üreticinin kendi istemcisi kullanılmayan indeksi hiç yazmıyor, kullanılanı atlamıyor.
 *
 * 0-3 için eşleme yoksa kimlik (identity) yazılır: tablo her baskıda tam gönderilsin ki
 * ekrandan set edilmiş BAYAT bir tablo bu baskıyı etkilemesin. 3'ün üstünde kimlik YAZILMAZ —
 * fiziksel kafa 0-3 ile sınırlı, `[4, 4]` geçersiz bir hedef olurdu.
 */
export function buildSnapmakerMapTable(toolMap?: Record<number, number>): string {
  const keys = Object.keys(toolMap ?? {}).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
  const maxLogical = Math.max(3, ...(keys.length ? keys : [3]));
  const pairs: string[] = [];
  for (let i = 0; i <= maxLogical; i++) {
    if (toolMap && i in toolMap) pairs.push(`[${i}, ${toolMap[i]}]`);
    else if (i <= 3) pairs.push(`[${i}, ${i}]`);
  }
  return pairs.join(", ");
}

function buildSnapmakerStartScript(
  filename: string,
  meta: Record<string, unknown>,
  prefs?: MoonrakerPrefs,
  toolMap?: Record<number, number>,
): string {
  const esc = filename.replace(/"/g, '\\"');
  let s = `SDCARD_PRINT_FILE_WITH_PARAMETERS FILENAME="${esc}"`;
  s += ` BED_LEVEL="${prefs?.bedLeveling ? 1 : 0}" FLOW_CALIBRATE="${prefs?.flowCali ? 1 : 0}" TIME_LAPSE_CAMERA="${prefs?.timelapse ? 1 : 0}"`;
  // KAFA EŞLEME — firmware'in NATIVE canlı tablosu (u1-klipper print_task_config MAP_TABLE,
  // [mantıksal, fiziksel] çiftleri). Metin-remap'ten üstün: T<n>, M104/M109 T<n>,
  // SM_PRINT_START_LINE INDEX= ve ısıtma/besleme kapıları dahil HER ŞEY tutarlı eşlenir;
  // metadata dizileri MANTIKSAL indeksli kalır (permütasyon gerekmez). Identity olsa bile HER
  // baskıda gönderilir → boştayken ekrandan set edilmiş bayat tablo etkisiz (çifte-remap imkânsız).
  s += ` MAP_TABLE="[${buildSnapmakerMapTable(toolMap)}]"`;
  for (const field of SM_META_FIELDS) {
    let out: string | null = null;
    if (field === "filament_used_g") {
      const w = (meta as any).filament_weight;
      if (w != null) out = pyRepr(w);
    } else if (field === "filament_type") {
      const ft = (meta as any).filament_type;
      if (ft != null) {
        out = "[" + String(ft).split(";").map((it) => `'${it || "NONE"}'`).join(", ") + "]";
      }
    } else {
      const v = (meta as any)[field];
      if (v != null && v !== "") out = pyRepr(v);
    }
    if (out != null) s += ` ${field.toUpperCase()}="${out}"`;
  }
  return s;
}

/**
 * Dosyayı yükle + baskıyı başlat.
 *  - **Snapmaker U1** → upload(`print=false`) + `SDCARD_PRINT_FILE_WITH_PARAMETERS` (native akış: print_task_config'i
 *    doldurur → SAHTE runout YOK; calibration tercihlerini geçirir).
 *  - **Diğer Moonraker (Elegoo)** → upload(`print=true`) (atomik; bu makro Elegoo'da yok).
 *  Dosya byte-for-byte gider; SADECE gerçek (identity olmayan) kafa remap'inde gcode'a dokunulur.
 */
/**
 * Moonraker'a GERÇEK yüzde ilerlemeli yükleme — multipart gövde ELLE akıtılır (fetch(FormData)
 * byte takibi vermiyor; Moonraker'da sunucu-taraflı upload progress da yok, ama gövdeyi akış
 * halinde parse eder → istemci tarafında yazılan bayt ≈ gerçek ilerleme). U1 `checksum` (SHA256)
 * alanını doğrular (bozuk aktarım = HTTP 422); Elegoo'nun eski Moonraker'ı alanı yok sayar.
 * Zaman aşımı dosya boyutuyla ölçeklenir (eski sabit 180sn büyük dosyada yetmeyebiliyordu).
 */
/**
 * AKTARIM HIZ SINIRI (KB/sn) — 0 / verilmezse sınırsız.
 *
 * ÖLÇÜLDÜ (21 Ağu 2026): Snapmaker U1'e tam hızda dosya yüklenirken kart ağdan TAMAMEN
 * düşüyor (ICMP yok, 7125/80/22 üçü de zaman aşımı — "reddedildi" bile değil), aktarım
 * iptal oluyor ve cihaz elle kapatılıp açılana kadar dönmüyor. Düşüş yüzdesi sabit değil
 * (%5, %24, %40-50) → boyut eşiği değil, hattı doldurmanın kendisi.
 *
 * Karşılaştırma: Bambu'nun FTP'si 183 KB/sn veriyor ve hiç düşmüyor. Yani düşük hız
 * kullanılabilir bir çalışma noktası.
 *
 * `MLHUB_UPLOAD_KBPS` ile sürüm çıkmadan ayarlanabilir (0 = sınırsız).
 */
function yuklemeHizSiniriKbps(marka?: string): number {
  const env = Number(process.env.MLHUB_UPLOAD_KBPS);
  if (Number.isFinite(env) && env >= 0) return env;
  /**
   * VARSAYILAN SINIRSIZ.
   *
   * Bir ara Snapmaker'a sınır konmuştu; kullanıcı bunun yanlış teşhis olduğunu bildirdi:
   * aynı boyuttaki dosyalar aylardır sorunsuz yükleniyordu, yavaşlatmak yeni bir şey
   * kazandırmıyor. Sorun aktarım hızı değil, aktarım SIRASINDA yazıcıya bindirdiğimiz
   * ek yük (durum, yan bilgiler, meta ve slot sorguları) — o yollar artık susturuluyor.
   *
   * Ayar yine de duruyor: eşiği sahada aramamız gerekirse `MLHUB_UPLOAD_KBPS` ile
   * yeni derleme beklemeden denenebilir.
   */
  void marka;
  return 0;
}

async function moonrakerUploadStream(
  host: string,
  port: number,
  fileBuf: Buffer,
  filename: string,
  print: boolean,
  onProgress?: (pct: number) => void,
  hizKbps = 0,
): Promise<unknown> {
  const p = await resolveMoonrakerPort(host, port);
  const boundary = `----mlhub${crypto.randomUUID().replace(/-/g, "")}`;
  const safeName = filename.replace(/"/g, "");
  const checksum = crypto.createHash("sha256").update(fileBuf).digest("hex");
  const field = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = Buffer.from(
    field("root", "gcodes") +
      field("print", print ? "true" : "false") +
      field("checksum", checksum) +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const timeoutMs = Math.max(180_000, Math.ceil(fileBuf.length / (200 * 1024)) * 1000); // ≥180sn, ~200KB/sn tabanı

  /**
   * Aktarım boyunca durum yoklamasını sustur. Ölçüldü (21 Ağu 2026): U1 büyük dosya
   * alırken ağdan tamamen düşüyor; biz de tam o sırada panelden ve relay'den durum
   * sorgusu bindiriyorduk. Yükü kaldırmak düşme sebeplerinden birini ortadan kaldırıyor,
   * ayrıca kart "ulaşılamadı" yalanını söylemiyor.
   */
  aktarimBasladi(host);
  const bitir = () => aktarimBitti(host);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port: p,
        path: "/server/files/upload",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": head.length + fileBuf.length + tail.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          bitir();
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) {
            try { resolve(unwrap(JSON.parse(data))); } catch { resolve(null); }
          } else if (code === 413) {
            reject(new Error("Yazıcıda yer yok — eski baskı dosyalarını silip tekrar dene."));
          } else if (code === 422) {
            reject(new Error("Dosya aktarımda bozuldu (bütünlük doğrulaması) — tekrar dene."));
          } else {
            reject(new Error(`Yükleme başarısız (HTTP ${code}) ${data.slice(0, 140)}`.trim()));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Yükleme zaman aşımı — ağ yavaş ya da yazıcı yanıt vermiyor")));
    req.on("error", (e) => {
      bitir();
      /**
       * Ham soket hatası kullanıcıya gösterilmez: "read ECONNRESET" hiçbir şey anlatmıyor.
       * Bu hatalar sahada TEK bir şey demek — yazıcının ağ bağlantısı aktarımı taşıyamadı.
       */
      const kod = (e as NodeJS.ErrnoException).code || "";
      const agKoptu = ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "EHOSTUNREACH"].includes(kod);
      reject(new Error(
        agKoptu
          ? "Yazıcıyla bağlantı aktarım sırasında koptu. Yazıcının kablosuz bağlantısı zayıf olabilir — modeme yaklaştırmayı ya da kabloyla bağlamayı dene."
          : `Yükleme hatası: ${e.message}`
      ));
    });

    req.write(head);
    /**
     * Parça 256 KB değil 64 KB: hız sınırı uygulanacaksa duraklamalar sık ve kısa olmalı,
     * yoksa aktarım "yaz-bekle-yaz" diye kesikli akar ve ilerleme çubuğu sıçrar.
     */
    const CHUNK = 64 * 1024;
    const baytSaniye = hizKbps > 0 ? hizKbps * 1024 : 0;
    const basladi = Date.now();
    let off = 0;
    let lastPct = -1;
    const writeNext = () => {
      while (off < fileBuf.length) {
        const end = Math.min(off + CHUNK, fileBuf.length);
        const ok = req.write(fileBuf.subarray(off, end));
        off = end;
        if (onProgress) {
          // 99 tavanı: son dilimden sonra sunucu metadata taraması yapar — %100'ü yanıt gelince
          // çağıran katman (done aşaması) söyler, bar "bitti ama bitmedi" yalanı söylemez.
          const pct = Math.min(99, Math.floor((off / fileBuf.length) * 100));
          if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        }
        if (baytSaniye > 0) {
          // Planlanan süreye göre öndeysek bekle — kartın WiFi'ına nefes aldır.
          const olmasiGereken = (off / baytSaniye) * 1000;
          const gecen = Date.now() - basladi;
          if (olmasiGereken - gecen > 4) {
            setTimeout(writeNext, Math.ceil(olmasiGereken - gecen));
            return;
          }
        }
        if (!ok) { req.once("drain", writeNext); return; }
      }
      req.end(tail);
    };
    writeNext();
  });
}

export async function moonrakerUploadAndPrint(
  host: string,
  port: number,
  fileBuf: Buffer,
  filename: string,
  opts: { headMapping?: number[]; prefs?: MoonrakerPrefs; brand?: string; onProgress?: (pct: number) => void } = {}
): Promise<void> {
  const isSnapmaker = (opts.brand || "").toLowerCase() === "snapmaker";
  // Yüklemeden ÖNCE boşta-kontrolü — meşgul yazıcıya upload etmek boşa bant genişliği + Elegoo'da
  // (print=true) sessizce basmayan sahte-başarı üretiyordu.
  await assertMoonrakerIdle(host, port);
  let body = fileBuf;
  const isGcode = /\.(gcode|gco|g)$/i.test(filename);
  let activeToolMap: Record<number, number> | undefined;
  if (isGcode && opts.headMapping && opts.headMapping.length) {
    const toolMap: Record<number, number> = {};
    opts.headMapping.forEach((head, idx) => { if (typeof head === "number" && head >= 0) toolMap[idx] = head; });
    const keys = Object.keys(toolMap).map(Number);
    if (keys.length && !keys.every((k) => toolMap[k] === k)) {
      activeToolMap = toolMap;
      // Snapmaker: eşleme NATIVE MAP_TABLE ile yapılır (aşağıda) — dosyaya DOKUNULMAZ
      // (byte-for-byte ilkesi geri geldi; firmware her komutu kendi canlı tablosunda eşler).
      // Diğer Moonraker tool-changer'lar için metin-remap yedek olarak kalır.
      if (!isSnapmaker) {
        body = Buffer.from(remapMoonrakerTools(fileBuf.toString("latin1"), toolMap), "latin1");
      }
    }
  }
  /**
   * PARÇA İPTALİNİ ÇALIŞIR HÂLE GETİR.
   *
   * Dilimleyicilerin "Label objects" ayarı yalnız `; printing object …` YORUMU yazıyor;
   * Klipper'ın parça iptali ise EXCLUDE_OBJECT KOMUTLARINI istiyor ve o ayrı bir seçenek
   * ("Exclude objects"). Ölçüldü (25 Ağu 2026, kullanıcının U1'inde basılan gerçek dosya):
   * yorumlar vardı, komut sayısı SIFIRDI → panelde parça iptali hiç açılamıyordu.
   *
   * Eksik komutları burada ekliyoruz; dilimleyici ayarı ne olursa olsun çalışır. Yorumlar
   * korunur, dosyanın kalanı bayt bayt aynı kalır. Komutlar zaten varsa DOKUNULMAZ.
   *
   * Maliyet ölçüldü: 81 MB'lık dosyada ~700 ms, dosya %0,9 büyüyor — dakikalarca süren
   * aktarımın yanında görünmez.
   */
  if (isGcode) {
    try {
      const eklendi = excludeObjectEkle(body);
      if (eklendi) body = eklendi.cikti;
    } catch {
      // Dönüşüm başarısızsa ÖZGÜN dosya gönderilir — baskıyı riske atmaktansa özellik kapalı kalsın.
    }
  }

  // Upload — GERÇEK yüzde ilerlemeli akış. Snapmaker: print=false (başlatma ayrı, parametreli);
  // diğer: print=true (atomik).
  const uploadResp = await moonrakerUploadStream(
    host, port, body, filename, !isSnapmaker, opts.onProgress, yuklemeHizSiniriKbps(opts.brand),
  );
  if (!isSnapmaker) {
    // Elegoo (print=true): Moonraker dosyayı alıp BASMAMIŞ olabilir (meşgul/hazır değil) —
    // yanıt HTTP 2xx gelir ama print_started:false taşır. Açıkça false ise hata fırlat.
    if (uploadResp && (uploadResp as { print_started?: boolean }).print_started === false) {
      throw new Error("Yazıcı dosyayı aldı ama baskıyı başlatmadı — ekranından hazır olduğunu kontrol et.");
    }
    return;
  }

  // Snapmaker: native start_print_advanced replikası → print_task_config dolar, sahte runout önlenir.
  const meta = await moonrakerRawMeta(host, port, filename);
  if ((meta as any).filament_type == null) {
    const ft = filamentTypeFromGcode(body);
    if (ft) (meta as any).filament_type = ft;
  }
  // toolMap geçilir → metadata dizileri (filament_type/nozzle_temp/…) fiziksel kafalara hizalanır.
  await moonrakerGcodeScript(host, port, buildSnapmakerStartScript(filename, meta, opts.prefs, activeToolMap));
}

export async function moonrakerFiles(host: string, port: number): Promise<MoonrakerFile[]> {
  const res = await mreq(host, port, `/server/files/list?root=gcodes`, undefined, 6000);
  if (!res.ok) throw new Error(`Dosya listesi alınamadı (HTTP ${res.status})`);
  const arr = unwrap(await res.json());
  return (Array.isArray(arr) ? arr : []).map((f: any) => ({
    path: String(f.path ?? ""),
    modified: Number(f.modified) || 0,
    size: Number(f.size) || 0,
  }));
}

/** Kaydetmeden önce bağlantı testi — çalışan portu da döndürür (UI port alanını günceller). */
function normalizeHex(c: unknown): string {
  if (typeof c === "string") {
    const h = c.startsWith("#") ? c.slice(1) : c;
    if (/^[0-9a-fA-F]{6,8}$/.test(h)) return `#${h.slice(0, 6)}`;
  }
  return "#9ca3af";
}

type MoonrakerSlot = { slot: number; color: string; type: string; empty: boolean };

/**
 * U1 CFS `filament_detect` objesini slot dizisine çevir.
 * Gerçek yapı (Snapmaker/u1-klipper · klippy/extras/filament_detect.py get_status):
 *   status.filament_detect = { info: [4 kanal], state: [4] }
 *   info[i] = { VENDOR, MAIN_TYPE, SUB_TYPE, RGB_1 (int), ARGB_COLOR, ALPHA, OFFICIAL, ... }
 *   YÜKLÜ DEĞİL varsayılan: MAIN_TYPE="NONE", RGB_1=0xFFFFFF (beyaz), OFFICIAL=false → renk YOK say.
 * `present(i)` = filament_motion_sensor e{i}_filament.filament_detected (gerçek doluluk).
 */
function parseFilamentDetect(fd: any, present?: (i: number) => boolean | null): MoonrakerSlot[] {
  let arr: any[] = [];
  if (Array.isArray(fd?.info)) arr = fd.info;
  else if (Array.isArray(fd)) arr = fd;
  else if (Array.isArray(fd?.slots)) arr = fd.slots;
  else if (Array.isArray(fd?.filaments)) arr = fd.filaments;
  else if (Array.isArray(fd?.trays)) arr = fd.trays;
  else return [];

  return arr.map((v, i) => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, any>;
    const rgb: number | null =
      typeof o.RGB_1 === "number" ? o.RGB_1
      : typeof o.rgb_1 === "number" ? o.rgb_1
      : typeof o.ARGB_COLOR === "number" ? (o.ARGB_COLOR & 0xffffff)
      : null;
    const main = typeof o.MAIN_TYPE === "string" ? o.MAIN_TYPE : (typeof o.material === "string" ? o.material : "");
    const sub = typeof o.SUB_TYPE === "string" ? o.SUB_TYPE : "";
    const hasType = !!main && main.toUpperCase() !== "NONE";
    const type = hasType ? (sub && !["basic", "none", ""].includes(sub.toLowerCase()) ? `${main} ${sub}` : main) : "";
    const official = o.OFFICIAL === true;
    const vendorKnown = typeof o.VENDOR === "string" && o.VENDOR.toUpperCase() !== "NONE";
    // Varsayılan beyaz + başka bilgi yoksa "renk yok" (boş slot beyaz görünmesin).
    const realColor = rgb != null && rgb >= 0 && !(rgb === 0xffffff && !hasType && !official && !vendorKnown);
    let color = "#9ca3af";
    if (realColor) color = `#${(rgb! & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
    else {
      const hx = normalizeHex(o.color_hex ?? o.colorHex ?? o.color ?? o.colour ?? o.hex);
      if (hx !== "#9ca3af") color = hx;
    }
    const detected = present ? present(i) : null;
    const hasInfo = hasType || official || vendorKnown || color !== "#9ca3af";
    const empty = detected != null ? !detected : !hasInfo;
    return { slot: i, color, type, empty };
  });
}

/**
 * Snapmaker U1 `print_task_config` → kafa başına RENK + TİP + DOLULUK.
 * Gerçek kaynak (u1-klipper/print_task_config.py): touchscreen + Snapmaker Orca buradan okur.
 *   filament_color_rgba: ["RRGGBBAA"×4]  ·  filament_type: [...]  ·  filament_exist: [bool×4]
 * RFID'siz (3. parti) elle ayarlanan renkler de BURADA (filament_detect'te değil).
 */
function parsePrintTaskConfig(ptc: any): MoonrakerSlot[] | null {
  if (!ptc || typeof ptc !== "object") return null;
  const rgba = ptc.filament_color_rgba;
  const multi = ptc.filament_color_multi;
  const types = ptc.filament_type;
  const subs = ptc.filament_sub_type;
  const exist = ptc.filament_exist;
  if (!Array.isArray(rgba) && !Array.isArray(multi)) return null;
  const n = Math.max(Array.isArray(rgba) ? rgba.length : 0, Array.isArray(multi) ? multi.length : 0);
  const out: MoonrakerSlot[] = [];
  for (let i = 0; i < n; i++) {
    let hex: string | null = null;
    const r = Array.isArray(rgba) ? rgba[i] : null;
    if (typeof r === "string" && /^[0-9a-fA-F]{6,8}$/.test(r)) hex = r.slice(0, 6).toUpperCase(); // RRGGBBAA → RGB
    if (!hex) {
      const c = Array.isArray(multi) ? multi[i]?.colors?.[0] : null;
      if (typeof c === "string" && /^[0-9a-fA-F]{6}$/.test(c)) hex = c.toUpperCase();
    }
    const main = Array.isArray(types) && typeof types[i] === "string" ? types[i] : "";
    const sub = Array.isArray(subs) && typeof subs[i] === "string" ? subs[i] : "";
    const hasType = !!main && main.toUpperCase() !== "NONE";
    const type = hasType ? (sub && !["basic", "none", ""].includes(sub.toLowerCase()) ? `${main} ${sub}` : main) : "";
    const present = Array.isArray(exist) ? exist[i] === true : null;
    out.push({ slot: i, color: hex ? `#${hex}` : "#9ca3af", type, empty: present != null ? !present : (!hex && !type) });
  }
  return out.length ? out : null;
}

/**
 * Snapmaker U1 slot renkleri. ÖNCE print_task_config (gerçek renk/tip/doluluk — touchscreen'in
 * yazdığı yer), olmazsa filament_detect (RFID) + motion sensor, olmazsa keşif.
 */
export async function fetchMoonrakerSlots(host: string, port: number): Promise<MoonrakerSlot[]> {
  // 1) print_task_config — kafa başına renk + tip + doluluk (asıl kaynak).
  try {
    const res = await mreq(host, port, `/printer/objects/query?print_task_config`, undefined, 1500);
    if (res.ok) {
      const ptc = unwrap(await res.json())?.status?.print_task_config;
      const parsed = parsePrintTaskConfig(ptc);
      if (parsed) return parsed;
    }
  } catch { /* sonraki yola düş */ }
  // 2) filament_detect (RFID) + filament_motion_sensor e0..e3 (doluluk) — yedek.
  try {
    const objs = [
      "filament_detect",
      "filament_motion_sensor e0_filament", "filament_motion_sensor e1_filament",
      "filament_motion_sensor e2_filament", "filament_motion_sensor e3_filament",
    ];
    const q = objs.map((o) => encodeURIComponent(o)).join("&");
    const res = await mreq(host, port, `/printer/objects/query?${q}`, undefined, 1500);
    if (res.ok) {
      const status = unwrap(await res.json())?.status ?? {};
      const fd = status.filament_detect;
      if (fd && Array.isArray(fd.info)) {
        const present = (i: number): boolean | null => {
          const ms = status[`filament_motion_sensor e${i}_filament`];
          return ms && typeof ms.filament_detected === "boolean" ? ms.filament_detected : null;
        };
        const parsed = parseFilamentDetect(fd, present);
        if (parsed.length) return parsed;
      }
    }
  } catch { /* keşfe düş */ }
  // 2) Keşif: CFS/filament ile ilgili objeleri bul (firmware sürümüne göre ad değişebilir:
  //    filament_detect, cfs, box, feeder, mmu, tray...). Geniş filtre + iki strateji.
  try {
    const listRes = await mreq(host, port, `/printer/objects/list`, undefined, 1200);
    if (!listRes.ok) return [];
    const objs: string[] = unwrap(await listRes.json())?.objects ?? [];
    const cand = objs
      .filter((o) => /filament|cfs|rfid|spool|tray|ams|slot|channel|colou?r|material|feeder|box|mmu/i.test(o))
      .slice(0, 24);
    if (!cand.length) return [];
    const q = cand.map((o) => encodeURIComponent(o)).join("&");
    const res = await mreq(host, port, `/printer/objects/query?${q}`, undefined, 1200);
    if (!res.ok) return [];
    const status = unwrap(await res.json())?.status ?? {};
    // Strateji A: CFS-tarzı .info[] dizisi taşıyan bir obje varsa onu parse et (filament_detect şeması).
    for (const val of Object.values(status)) {
      const v = (val ?? {}) as Record<string, unknown>;
      if (Array.isArray((v as { info?: unknown }).info)) {
        const parsed = parseFilamentDetect(v);
        if (parsed.length) return parsed;
      }
    }
    // Strateji B: her objeyi tek slot say (color/type alanları).
    const slots: MoonrakerSlot[] = [];
    let i = 0;
    for (const val of Object.values(status)) {
      const v = (val ?? {}) as Record<string, unknown>;
      const rfid = (v.rfid ?? {}) as Record<string, unknown>;
      const color = v.color ?? v.colour ?? v.hex ?? v.rgb ?? (v as { RGB_1?: unknown }).RGB_1 ?? rfid.color ?? rfid.colour;
      const type = v.material ?? v.type ?? v.filament_type ?? (v as { MAIN_TYPE?: unknown }).MAIN_TYPE ?? rfid.material;
      if (color != null || type != null) {
        const rgbHex = typeof color === "number" && color > 0
          ? `#${(color & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`
          : normalizeHex(color);
        slots.push({ slot: i, color: rgbHex, type: typeof type === "string" ? type : "", empty: false });
      }
      i++;
    }
    return slots;
  } catch {
    return [];
  }
}

/**
 * TANILAMA: yazıcının açığa çıkardığı obje listesi + filament_detect ham yanıtı + CFS aday
 * objelerinin ham değerleri. Slot renkleri okunamadığında kullanıcı bunu paylaşır → şema eşlenir.
 */
export async function fetchMoonrakerSlotDebug(
  host: string,
  port: number
): Promise<{ objects: string[]; filamentDetect: unknown; candidates: Record<string, unknown> }> {
  let objects: string[] = [];
  let filamentDetect: unknown = null;
  const candidates: Record<string, unknown> = {};
  try {
    const listRes = await mreq(host, port, `/printer/objects/list`, undefined, 4000);
    if (listRes.ok) objects = unwrap(await listRes.json())?.objects ?? [];
  } catch { /* yoksa boş */ }
  try {
    const fdRes = await mreq(host, port, `/printer/objects/query?filament_detect`, undefined, 4000);
    if (fdRes.ok) filamentDetect = unwrap(await fdRes.json())?.status?.filament_detect ?? null;
  } catch { /* yoksa null */ }
  const cand = objects
    .filter((o) => /filament|cfs|rfid|spool|tray|ams|slot|channel|colou?r|material|feeder|box|mmu/i.test(o))
    .slice(0, 24);
  if (cand.length) {
    try {
      const q = cand.map((o) => encodeURIComponent(o)).join("&");
      const res = await mreq(host, port, `/printer/objects/query?${q}`, undefined, 4000);
      if (res.ok) Object.assign(candidates, unwrap(await res.json())?.status ?? {});
    } catch { /* atla */ }
  }
  return { objects, filamentDetect, candidates };
}

export async function testMoonraker(host: string, port: number): Promise<{ ok: boolean; hostname?: string; state?: string; port?: number; error?: string }> {
  let lastErr = "";
  for (const p of candidatePorts(port)) {
    try {
      const res = await mfetch(`http://${host}:${p}/printer/info`, undefined, 4000);
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const r = unwrap(await res.json());
      rememberPort(host, p);
      return { ok: true, hostname: r?.hostname, state: r?.state, port: p };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "bağlanılamadı";
    }
  }
  return { ok: false, error: lastErr || "bağlanılamadı" };
}

// ── Yetenek keşfi + gelişmiş kontroller ─────────────────────────────────────────────────────
//
// Üç Moonraker yazıcının üçü de FARKLI (canlı `/printer/objects/list` + `/printer/gcode/help`
// ile doğrulandı, 12 Ağu):
//   Snapmaker U1        → `led cavity_led` (yalnız beyaz kanal) · SET_PAUSE_AT_LAYER · M600
//                          · `defect_detection` (spagetti + kirli tabla gözetimi)
//   Neptune 4 Pro       → `output_pin caselight` (nozul) + `caselight1` (logo) · M600
//   Neptune 4 Plus      → yalnız MODLELIGHT_SWITCH / FLASHLIGHT_SWITCH (kabuk betiği) →
//                          DEĞİŞTİR var, DURUM OKUNAMAZ
// Bu yüzden yetenekler sabit kodlanmaz, yazıcıdan keşfedilir; desteklenmeyen komut SESSİZCE
// YUTULMAZ, net bir hata döner.

export type MoonrakerLightKind = "led" | "pin" | "toggle" | "none";

export interface MoonrakerCaps {
  lightKind: MoonrakerLightKind;
  /** SET_LED için LED adları, SET_PIN için pin adları, toggle için makro adları. */
  lightTargets: string[];
  pauseAtLayer: boolean;
  filamentChange: boolean;
  defectDetection: boolean;
  speed: boolean;
  /**
   * Keşif GERÇEKTEN tamamlandı mı. false = yazıcı o an yanıt vermedi → "desteklemiyor" DEĞİL,
   * "bilinmiyor". Çağıranlar bu ikisini karıştırırsa kullanıcıya yanlış kesinlikle
   * "yazıcın bunu desteklemiyor" deniyor.
   */
  discovered: boolean;
}

const NO_CAPS: MoonrakerCaps = {
  lightKind: "none", lightTargets: [], pauseAtLayer: false,
  filamentChange: false, defectDetection: false, speed: false, discovered: false,
};

const capsCache = processSingleton("mr_capsCache", () => new Map<string, { at: number; caps: MoonrakerCaps }>());
/** Yetenekler firmware güncellemesi dışında değişmez → uzun önbellek (her kart açılışında sorma). */
const CAPS_TTL_MS = 15 * 60_000;

/** Yazıcının desteklediği kontroller — iki salt-okunur istekle keşfedilir, uzun önbellekli. */
/**
 * BAŞARISIZ keşif de kısa süre hatırlanır.
 *
 * Yetenek keşfi iki AĞIR istek atıyor (`/printer/objects/list` + `/printer/gcode/help`).
 * Başarı 15 dakika önbellekleniyordu ama BAŞARISIZLIK hiç — yazıcı meşgulken (baskı sırasında
 * sık) bu iki istek her 15 saniyede bir tekrarlanıyordu, yani 60 kat fark. Yazıcının zorlandığı
 * anda üstüne binen yükün bir kısmı buydu.
 */
const CAPS_HATA_TTL_MS = 60_000;
const capsHata = processSingleton("mr_capsHata", () => new Map<string, number>());

export async function fetchMoonrakerCaps(host: string, port: number): Promise<MoonrakerCaps> {
  const hit = capsCache.get(host);
  if (hit && Date.now() - hit.at < CAPS_TTL_MS) return hit.caps;
  const sonHata = capsHata.get(host);
  if (sonHata != null && Date.now() - sonHata < CAPS_HATA_TTL_MS) return NO_CAPS;

  const caps: MoonrakerCaps = { ...NO_CAPS };
  try {
    const [objsRes, helpRes] = await Promise.all([
      mreq(host, port, `/printer/objects/list`, undefined, 3000),
      mreq(host, port, `/printer/gcode/help`, undefined, 3000),
    ]);
    // İKİSİ de başarılı olmalı: biri düşerse tablo YARIM olur (help boşsa M600/katman duraklatma
    // "yok" görünür, objects boşsa ışık kaybolur) ve 15 dakika boyunca o yarım tablo servis edilirdi.
    if (!objsRes.ok || !helpRes.ok) { capsHata.set(host, Date.now()); return NO_CAPS; }
    const objects: string[] = (unwrap(await objsRes.json())?.objects as string[]) ?? [];
    const help: Record<string, string> = (unwrap(await helpRes.json()) as Record<string, string>) ?? {};
    if (!objects.length && !Object.keys(help).length) { capsHata.set(host, Date.now()); return NO_CAPS; } // yazıcı yanıt vermedi
    const cmds = new Set(Object.keys(help).map((k) => k.toUpperCase()));

    const leds = objects.filter((o) => /^led\s+\S/i.test(o)).map((o) => o.replace(/^led\s+/i, ""));
    const pins = objects
      .filter((o) => /^output_pin\s+(caselight|chamber_?light|light|led)/i.test(o))
      .map((o) => o.replace(/^output_pin\s+/i, ""));
    const toggles = [...cmds].filter((k) => /^(MODLELIGHT|MODELLIGHT|FLASHLIGHT|CASELIGHT|LIGHT)_SWITCH$/.test(k));
    // TÜM ışıklar sürülür — kullanıcı "açtığımda ikisi de açılsın" dedi (bkz. allLightTargets).
    // Mutlak kipte (led/pin) bu risksizdir; toggle kipinde faz kayması yazıcının kendi
    // ekranından müdahale edilirse mümkündür ve okunamadığı için düzeltilemez.
    if (leds.length && cmds.has("SET_LED")) { caps.lightKind = "led"; caps.lightTargets = allLightTargets(leds); }
    else if (pins.length && cmds.has("SET_PIN")) { caps.lightKind = "pin"; caps.lightTargets = allLightTargets(pins); }
    else if (toggles.length) { caps.lightKind = "toggle"; caps.lightTargets = allLightTargets(toggles); }

    caps.pauseAtLayer = cmds.has("SET_PAUSE_AT_LAYER");
    caps.filamentChange = cmds.has("M600");
    caps.defectDetection = objects.includes("defect_detection");
    caps.speed = true; // M220 Klipper'ın çekirdeğinde — her Moonraker yazıcıda var
    caps.discovered = true;
    capsCache.set(host, { at: Date.now(), caps });
  } catch {
    // Ağ hatası da damgalanır: yazıcı meşgulken bu iki ağır istek 15 sn'de bir tekrarlanıyordu.
    capsHata.set(host, Date.now());
    return NO_CAPS; // keşif başarısızsa hiçbir kontrolü "var" gösterme
  }
  return caps;
}

/**
 * Kabin ışığı tercih sırası. Ön aydınlatma/el feneri (`flashlight`) ışık düğmesine BAĞLANMAZ;
 * kullanıcının "ışık" dediği şey kabin/tabla aydınlatmasıdır.
 */
// "MODLELIGHT" firmware'in kendi yazım hatası (MODEL değil MODLE) — iki yazım da tanınır.
const LIGHT_PREFERENCE = [/caselight(?!\d)/i, /chamber_?light/i, /cavity/i, /mod(?:le|el)light/i, /caselight/i, /light/i, /led/i];

export function pickLightTarget(targets: string[]): string {
  for (const re of LIGHT_PREFERENCE) {
    const hit = targets.find((t) => re.test(t) && !/flashlight/i.test(t));
    if (hit) return hit;
  }
  return targets.find((t) => !/flashlight/i.test(t)) ?? targets[0];
}

/**
 * Yazıcının TÜM ışıkları — tercih sırasına göre dizili, tekrarsız.
 *
 * Kullanıcı: "ya açarım, ya kaparım. açtığımda ikisi de açılır." Yazıcılarda birden çok
 * bağımsız ışık var (Neptune 4 Pro: `caselight` kabin + `caselight1` logo; Neptune 4 Plus:
 * MODLELIGHT logo + FLASHLIGHT kafa) ve düğme yalnız BİRİNİ sürüyordu.
 *
 * MUTLAK kontrolde (pin/led) hepsini sürmek risksizdir: aynı değer yazılır, faz kayması
 * imkânsızdır. DEĞİŞTİR (toggle) kipinde ise kayma mümkündür — yazıcının kendi ekranından
 * biri kapatılırsa ikisi ters fazda kalır ve uygulama bunu göremez (durum okunamıyor;
 * Neptune 4 Plus'ta ışıklar Klipper pini değil `sh /home/mks/sled*.sh` kabuk betiği ve betik
 * hiçbir durum bildirmiyor — 14 Ağu 2026'da yazıcıya sorularak doğrulandı).
 */
export function allLightTargets(targets: string[]): string[] {
  const sirali: string[] = [];
  for (const re of LIGHT_PREFERENCE) {
    for (const t of targets) {
      if (re.test(t) && !/flashlight/i.test(t) && !sirali.includes(t)) sirali.push(t);
    }
  }
  for (const t of targets) if (!sirali.includes(t)) sirali.push(t);
  return sirali;
}

/** Test/relay için: keşfedilen yetenekleri unut (yazıcı ayarı değişti / firmware güncellendi). */
export function clearMoonrakerCaps(host?: string): void {
  if (host) capsCache.delete(host);
  else capsCache.clear();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * MADDE 10 — Baskı hızı (M220). Sınırlar SUNUCUDA (controls.ts) zorlanır; burada yalnız uygulanır
 * ve yazıcının değeri gerçekten aldığı DOĞRULANIR.
 */
export async function moonrakerSetSpeed(host: string, port: number, pct: number): Promise<number> {
  const target = Math.round(pct);
  // MADDE 9 ilkesi: istek zaman aşımına uğrasa bile DEĞER uygulandıysa komut başarılıdır.
  // (M220 Klipper'ın hareket kuyruğunun arkasına takılıp isteği geciktirebiliyor; kullanıcı
  // "olmadı" sanıp tekrar denerse ikinci komut gerçek hızın üstüne biner.)
  let failure: unknown = null;
  try {
    await moonrakerGcodeScript(host, port, `M220 S${target}`, {
      timeoutMs: 12_000,
      failMessage: "Hız değiştirilemedi.",
    });
  } catch (e) {
    failure = e;
  }
  for (let i = 0; i < 8; i++) {
    const st = await fetchMoonrakerStatus(host, port);
    if (st.online && st.speedPercent != null && Math.abs(st.speedPercent - target) <= 1) {
      return st.speedPercent;
    }
    await sleep(400);
  }
  if (failure) throw failure;
  throw new Error("Hız komutu gönderildi ama yazıcı yeni değeri uygulamadı.");
}

export interface MoonrakerLightState {
  supported: boolean;
  /** Işığın açık/kapalı olduğu okunabiliyor mu (Neptune 4 Plus'ta okunamaz). */
  readable: boolean;
  /** true = açık, false = kapalı, null = okunamıyor. */
  on: boolean | null;
}

/**
 * LED'in KULLANDIĞI kanal profili (host|led → [R,G,B,W]).
 *
 * Snapmaker U1'in kabin ışığı yalnız beyaz kanalı sürüyor (canlı okuma: color_data
 * [[0,0,0,1]]). Uygulamadan "aç" derken bütün kanallara 1 yazmak ışığın rengini yazıcının
 * kendi ayarından farklı bırakıyor ve yazıcı ekranından düzeltilene kadar öyle kalıyordu.
 * Işık AÇIKKEN görülen profil hatırlanır, tekrar açarken aynısı sürülür.
 */
const ledOnProfile = processSingleton("mr_ledOnProfile", () => new Map<string, number[]>());

function rememberLedProfile(host: string, led: string, data: unknown): void {
  if (!Array.isArray(data)) return;
  const nums = data.filter((c): c is number => typeof c === "number");
  if (nums.length && nums.some((c) => c > 0.01)) ledOnProfile.set(`${host}|${led}`, nums);
}

/** Açma komutunda sürülecek kanal değerleri. Profil bilinmiyorsa kanal SAYISINDAN karar verilir. */
function ledOnValues(host: string, led: string, channelCount: number): number[] {
  const known = ledOnProfile.get(`${host}|${led}`);
  if (known && known.length === channelCount) return known;
  // 4 kanallı (RGBW) şeritte "beyaz ışık" W kanalıdır; RGB'yi de sürmek rengi bozar.
  if (channelCount >= 4) return [0, 0, 0, 1];
  return new Array(Math.max(1, channelCount)).fill(1);
}

/** MADDE 16 — ışık durumu. Okunamayan modelde `readable:false` döner (uydurma değer YOK). */
export async function fetchMoonrakerLight(host: string, port: number): Promise<MoonrakerLightState> {
  const caps = await fetchMoonrakerCaps(host, port);
  if (caps.lightKind === "none") return { supported: false, readable: false, on: null };
  if (caps.lightKind === "toggle") return { supported: true, readable: false, on: null };
  try {
    const objs = caps.lightTargets.map((t) => (caps.lightKind === "led" ? `led ${t}` : `output_pin ${t}`));
    const q = objs.map((o) => encodeURIComponent(o)).join("&");
    const res = await mreq(host, port, `/printer/objects/query?${q}`, undefined, 2500);
    if (!res.ok) return { supported: true, readable: false, on: null };
    const status = (unwrap(await res.json())?.status ?? {}) as Record<string, unknown>;
    let anyOn = false;
    let sawValue = false;
    for (const name of objs) {
      const v = status[name] as Record<string, unknown> | undefined;
      if (!v) continue;
      if (caps.lightKind === "led") {
        const data = v.color_data;
        if (Array.isArray(data) && Array.isArray(data[0])) {
          sawValue = true;
          rememberLedProfile(host, name.replace(/^led\s+/i, ""), data[0]);
          if ((data[0] as number[]).some((c) => typeof c === "number" && c > 0.01)) anyOn = true;
        }
      } else if (typeof v.value === "number") {
        sawValue = true;
        if (v.value > 0.01) anyOn = true;
      }
    }
    return { supported: true, readable: sawValue, on: sawValue ? anyOn : null };
  } catch {
    return { supported: true, readable: false, on: null };
  }
}

/**
 * MADDE 16 — ışığı aç/kapa. `"toggle"` yalnız durumu okunamayan modeller için.
 * Desteklenmiyorsa net hata fırlatır (sessizce yutulmaz).
 */
export async function moonrakerSetLight(
  host: string, port: number, want: boolean | "toggle",
): Promise<MoonrakerLightState> {
  const caps = await fetchMoonrakerCaps(host, port);
  if (caps.lightKind === "none") throw new Error("Bu yazıcıda uygulamadan kontrol edilebilen ışık yok.");

  if (caps.lightKind === "toggle") {
    if (want !== "toggle") {
      // Durum okunamadığı için "aç"/"kapa" garanti edilemez — yalnız değiştirilebilir.
      throw new Error("Bu yazıcıda ışık yalnız değiştirilebiliyor, açık/kapalı ayarlanamıyor.");
    }
    for (const macro of caps.lightTargets) {
      await moonrakerGcodeScript(host, port, macro, { timeoutMs: 10_000, failMessage: "Işık değiştirilemedi." });
    }
    return { supported: true, readable: false, on: null };
  }

  let on: boolean;
  if (want === "toggle") {
    const cur = await fetchMoonrakerLight(host, port);
    on = !(cur.on ?? false);
  } else {
    on = want;
  }
  const v = on ? 1 : 0;
  for (const target of caps.lightTargets) {
    let script: string;
    if (caps.lightKind === "led") {
      // Kanal profilini KORU: yazıcının kendi "açık" hâli (U1'de yalnız beyaz) geri gelsin.
      const prof = ledOnProfile.get(`${host}|${target}`);
      const [r, g, b, w] = on ? ledOnValues(host, target, prof?.length ?? 4) : [0, 0, 0, 0];
      script = `SET_LED LED=${target} RED=${r ?? 0} GREEN=${g ?? 0} BLUE=${b ?? 0} WHITE=${w ?? 0} SYNC=0 TRANSMIT=1`;
    } else {
      script = `SET_PIN PIN=${target} VALUE=${v}`;
    }
    await moonrakerGcodeScript(host, port, script, {
      timeoutMs: 10_000,
      failMessage: on ? "Işık açılamadı." : "Işık kapatılamadı.",
    });
  }
  // Doğrula (okunabiliyorsa) — komutun gerçekten uygulandığını gösterir.
  for (let i = 0; i < 4; i++) {
    const st = await fetchMoonrakerLight(host, port);
    if (!st.readable || st.on === on) return st;
    await sleep(300);
  }
  throw new Error("Işık komutu gönderildi ama durum değişmedi.");
}

/**
 * MADDE 17 — belirli katmanda duraklat. Yalnız DEĞER AYARLAR; baskı o katmana gelince durur.
 * (Klipper istemci makrosu: `SET_PAUSE_AT_LAYER ENABLE=1 LAYER=<n>` — canlı config'den doğrulandı.)
 */
export async function moonrakerSetPauseAtLayer(host: string, port: number, layer: number | null): Promise<void> {
  const caps = await fetchMoonrakerCaps(host, port);
  if (!caps.pauseAtLayer) {
    throw new Error(caps.discovered
      ? "Bu yazıcı katmanda duraklatmayı desteklemiyor."
      : "Yazıcı şu an yanıt vermiyor — biraz sonra tekrar dene.");
  }
  const want = layer == null ? null : Math.round(layer);
  const script = want == null ? "SET_PAUSE_AT_LAYER ENABLE=0" : `SET_PAUSE_AT_LAYER ENABLE=1 LAYER=${want}`;
  // MADDE 9 ilkesi: istek zaman aşımına uğrasa bile DEĞER yazıcıda oluştuysa komut başarılıdır.
  try {
    await moonrakerGcodeScript(host, port, script, {
      timeoutMs: 10_000,
      failMessage: want == null ? "Katman duraklatması kapatılamadı." : "Katman duraklatması ayarlanamadı.",
    });
  } catch (e) {
    for (let i = 0; i < 4; i++) {
      if ((await fetchMoonrakerPauseAtLayer(host, port)) === want) return;
      await sleep(300);
    }
    throw e;
  }
}

/** Ayarlı katman duraklatması (yoksa null). Klipper istemci makrosunun değişkeninden okunur. */
export async function fetchMoonrakerPauseAtLayer(host: string, port: number): Promise<number | null> {
  try {
    const res = await mreq(
      host, port,
      `/printer/objects/query?${encodeURIComponent("gcode_macro SET_PRINT_STATS_INFO")}`,
      undefined, 2500,
    );
    if (!res.ok) return null;
    const v = unwrap(await res.json())?.status?.["gcode_macro SET_PRINT_STATS_INFO"]?.pause_at_layer;
    if (!v || typeof v !== "object") return null;
    const enabled = (v as { enable?: unknown }).enable === true;
    const layer = Number((v as { layer?: unknown }).layer);
    return enabled && Number.isFinite(layer) && layer > 0 ? layer : null;
  } catch {
    return null;
  }
}

/**
 * MADDE 17 — filament değişimi (M600). Baskıyı DURAKLATIR; kullanıcı filamenti değiştirip
 * "Devam" der. Duraklama gerçekleştiği DOĞRULANIR.
 */
export async function moonrakerChangeFilament(host: string, port: number): Promise<void> {
  const caps = await fetchMoonrakerCaps(host, port);
  if (!caps.filamentChange) {
    throw new Error(caps.discovered
      ? "Bu yazıcı filament değişimini desteklemiyor."
      : "Yazıcı şu an yanıt vermiyor — biraz sonra tekrar dene.");
  }
  // ÖN KOŞUL: yalnız BASARKEN. M600 makrosu duraklat+park+geri çekme yapar; boştaki (soğuk nozullu)
  // yazıcıda ekstrüzyon adımı hata verir ama DURAKLATMA kısmı çalışır → yazıcı boş bir işte
  // "paused" kalır, sonraki baskı "Yazıcı şu an meşgul" ile reddedilir ve kullanıcı elle
  // müdahale edene kadar kilitli kalırdı. Zaten duraklamış yazıcıda da doğrulama anlamsızdır.
  const before = await fetchMoonrakerStatus(host, port);
  if (!before.online) throw new Error("Filament değişimi yapılamadı — yazıcıya ulaşılamıyor.");
  if (before.state !== "printing") {
    throw new Error(
      before.state === "paused"
        ? "Baskı zaten duraklatılmış — filamenti değiştirip Devam'a bas."
        : "Filament değişimi yalnız baskı sürerken yapılabilir.",
    );
  }
  try {
    await moonrakerGcodeScript(host, port, "M600", { timeoutMs: 45_000, failMessage: "Filament değişimi başlatılamadı." });
  } catch (e) {
    // M600 makrosu duraklatma hareketlerini yaparken istek zaman aşımına uğrayabilir; asıl kanıt
    // durum. Komut öncesi "printing" olduğu doğrulandığı için "paused" GERÇEK bir geçiştir.
    const st = await waitForState(host, port, ["paused"], 15_000);
    if (!st) throw e;
    return;
  }
  const st = await waitForState(host, port, ["paused"], 20_000);
  if (!st) throw new Error("Filament değişimi komutu gönderildi ama baskı duraklamadı.");
}

/**
 * MADDE 22 — Snapmaker U1 spagetti / kirli tabla gözetimi.
 * Canlı keşifle bulundu: Klipper nesnesi `defect_detection`. AYARLARI yayınlar
 * (`noodle` = spagetti, `clean_bed` = kirli tabla, `residue` = artık, `nozzle` = nozul),
 * her biri `{enable, check_window, sensitivity}`. Yakalama SONUCU bu nesnede DEĞİL —
 * tespit anında baskı duraklar ve sebep `print_stats.exception` / `.message` alanına düşer
 * (bizim zaten okuduğumuz yer). Buradan yalnız "gözetim açık mı" bilgisi gelir.
 */
export interface MoonrakerDefectWatch {
  supported: boolean;
  enabled: boolean;
  /** Spagetti (noodle) gözetimi açık mı. */
  spaghetti: boolean;
  /** Kirli tabla gözetimi açık mı. */
  cleanBed: boolean;
}

export async function fetchMoonrakerDefectWatch(host: string, port: number): Promise<MoonrakerDefectWatch> {
  const off: MoonrakerDefectWatch = { supported: false, enabled: false, spaghetti: false, cleanBed: false };
  const caps = await fetchMoonrakerCaps(host, port);
  if (!caps.defectDetection) return off;
  try {
    const res = await mreq(host, port, `/printer/objects/query?defect_detection`, undefined, 2500);
    if (!res.ok) return { ...off, supported: true };
    const d = unwrap(await res.json())?.status?.defect_detection as Record<string, any> | undefined;
    if (!d) return { ...off, supported: true };
    const flag = (v: unknown) => !!(v && typeof v === "object" && (v as { enable?: unknown }).enable === true);
    return {
      supported: true,
      enabled: d.main_enable === true,
      spaghetti: flag(d.noodle),
      cleanBed: flag(d.clean_bed),
    };
  } catch {
    return { ...off, supported: true };
  }
}

/**
 * MADDE 12 — bu baskıda hangi kafalar/slotlar KULLANILIYOR.
 * Snapmaker U1: `print_task_config.extruders_used` (kafa başına bool). Tek kafalı yazıcılarda
 * her zaman [0]. Okunamazsa boş dizi (uydurma değer yok).
 */
export async function fetchMoonrakerActiveSlots(host: string, port: number): Promise<number[]> {
  try {
    const res = await mreq(host, port, `/printer/objects/query?print_task_config`, undefined, 2000);
    if (!res.ok) return [];
    const used = unwrap(await res.json())?.status?.print_task_config?.extruders_used;
    if (!Array.isArray(used)) return [];
    const out: number[] = [];
    used.forEach((v, i) => { if (v === true) out.push(i); });
    return out;
  } catch {
    return [];
  }
}

/**
 * Panelin ihtiyaç duyduğu YAN BİLGİLERİN HEPSİ — TEK istekte.
 *
 * Işık durumu, slot renkleri, kullanılan kafalar, katman duraklatması ve spagetti/tabla
 * gözetimi ayrı ayrı sorulsa yazıcı başına beş HTTP gidiş-dönüşü olurdu. Moonraker
 * `/printer/objects/query` birden çok nesneyi tek yanıtta verir → maliyet tek istek.
 * Sonuç status-cache'te 15sn tutulur (bu değerler saniyede değişmez).
 */
export interface MoonrakerExtras {
  /**
   * Yan bilgiler GERÇEKTEN okundu mu. false = yazıcı o an yanıt vermedi → "yok" DEĞİL,
   * "bilinmiyor". Çağıran bu ikisini karıştırırsa kurulu katman duraklatması, filament renkleri
   * ve ışık durumu 15 saniye boyunca ekrandan siliniyor.
   */
  read: boolean;
  caps: MoonrakerCaps;
  light: MoonrakerLightState;
  slots: { slot: number; color: string; type: string; empty: boolean }[];
  /** Bu baskıda kullanılan kafa/slot indeksleri (U1 `extruders_used`). */
  activeSlots: number[];
  /**
   * MANTIKSAL takım indeksi → FİZİKSEL kafa (U1 `print_task_config.extruder_map_table`).
   *
   * Gcode `T<n>` MANTIKSAL indeks yazar; yazıcının slot renkleri ise FİZİKSEL kafaya aittir.
   * İkisi aynı olmak zorunda değil (kullanıcı dilimleyicide 2. filamenti 4. kafaya bağlayabilir).
   * Bu tablo olmadan 3B görünüm yanlış makaranın rengini boyar.
   *
   * Canlı ölçüm (U1, 14 Ağu 2026): `[0,1,2,3,0,0,…]` — 32 elemanlı, sonu dolgu. Boşsa eşleme
   * bilinmiyor demektir, çağıran kimliğe (identity) düşer.
   */
  toolMap: number[];
  pauseAtLayer: number | null;
  defectWatch: MoonrakerDefectWatch;
  /** Yazıcının bildirdiği aktif uyarılar (U1 `exception_manager`) — spagetti/kirli tabla tespiti
   *  dahil her firmware uyarısı buraya düşer. */
  alerts: { code: string | null; text: string }[];
}

export function emptyMoonrakerExtras(): MoonrakerExtras {
  return {
    read: false,
    caps: { ...NO_CAPS },
    light: { supported: false, readable: false, on: null },
    slots: [],
    activeSlots: [],
    toolMap: [],
    pauseAtLayer: null,
    defectWatch: { supported: false, enabled: false, spaghetti: false, cleanBed: false },
    alerts: [],
  };
}

/** Bilinmeyen uyarı şeması gördüğümüzde BİR KEZ log'a düş — sonraki turda eşlemek için. */
const loggedUnknownAlert = processSingleton("mr_loggedUnknownAlert", () => new Set<string>());

export async function fetchMoonrakerExtras(host: string, port: number): Promise<MoonrakerExtras> {
  const out = emptyMoonrakerExtras();
  const caps = await fetchMoonrakerCaps(host, port);
  out.caps = caps;

  const objs: string[] = ["print_task_config", "gcode_macro SET_PRINT_STATS_INFO", "exception_manager"];
  if (caps.defectDetection) objs.push("defect_detection");
  if (caps.lightKind === "led") objs.push(...caps.lightTargets.map((t) => `led ${t}`));
  if (caps.lightKind === "pin") objs.push(...caps.lightTargets.map((t) => `output_pin ${t}`));
  // `readable` yalnız GERÇEKTEN değer okunduğunda true olur; sorgu düşerse "durum okunabiliyor"
  // deyip değer vermemek arayüzde değeri olmayan bir açık/kapalı anahtarı çizdiriyordu.
  const mayRead = caps.lightKind === "led" || caps.lightKind === "pin";
  out.light = { supported: caps.lightKind !== "none", readable: false, on: null };

  try {
    const q = objs.map((o) => encodeURIComponent(o)).join("&");
    const res = await mreq(host, port, `/printer/objects/query?${q}`, undefined, 2500);
    if (!res.ok) return out; // read=false kalır → çağıran son bilineni korur
    const status = (unwrap(await res.json())?.status ?? {}) as Record<string, any>;

    // Işık
    if (mayRead) {
      let sawValue = false;
      let anyOn = false;
      for (const t of caps.lightTargets) {
        const v = status[caps.lightKind === "led" ? `led ${t}` : `output_pin ${t}`];
        if (!v) continue;
        if (caps.lightKind === "led") {
          const d = v.color_data;
          if (Array.isArray(d) && Array.isArray(d[0])) {
            sawValue = true;
            rememberLedProfile(host, t, d[0]);
            if ((d[0] as number[]).some((c) => typeof c === "number" && c > 0.01)) anyOn = true;
          }
        } else if (typeof v.value === "number") {
          sawValue = true;
          if (v.value > 0.01) anyOn = true;
        }
      }
      out.light = { supported: true, readable: sawValue, on: sawValue ? anyOn : null };
    }

    // Slot renkleri + bu baskıda kullanılan kafalar (Snapmaker U1)
    const ptc = status.print_task_config;
    const parsed = parsePrintTaskConfig(ptc);
    if (parsed) out.slots = parsed;
    if (ptc && Array.isArray(ptc.extruder_map_table)) {
      const ham: number[] = ptc.extruder_map_table.map((v: unknown) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= 3 ? n : -1;
      });
      // DOLGUYU KIRP. Firmware tabloyu 32 elemana sıfırla dolduruyor (canlı ölçüm:
      // [0,1,2,3,0,0,…]) ve 0 aynı zamanda GEÇERLİ bir kafa numarası — ikisi dizinin kendisinden
      // ayırt edilemez. Son sıfır-olmayan girdiden sonrasını atıyoruz; yanlış kırparsak sonuç
      // kimliğe düşer (dosyanın kendi rengi kullanılır), yanlış RENK boyanmaz.
      let son = 3;
      for (let i = 0; i < ham.length; i++) if (ham[i] > 0) son = i;
      out.toolMap = ham.slice(0, Math.min(ham.length, son + 1));
    }
    if (ptc && Array.isArray(ptc.extruders_used)) {
      ptc.extruders_used.forEach((v: unknown, i: number) => { if (v === true) out.activeSlots.push(i); });
    }

    // Katmanda duraklatma (Klipper istemci makrosu değişkeni)
    const pal = status["gcode_macro SET_PRINT_STATS_INFO"]?.pause_at_layer;
    if (pal && typeof pal === "object" && pal.enable === true) {
      const n = Number(pal.layer);
      if (Number.isFinite(n) && n > 0) out.pauseAtLayer = n;
    }

    // Spagetti / kirli tabla gözetimi (AYARLAR)
    if (caps.defectDetection) {
      const d = status.defect_detection;
      const flag = (v: unknown) => !!(v && typeof v === "object" && (v as { enable?: unknown }).enable === true);
      out.defectWatch = d
        ? { supported: true, enabled: d.main_enable === true, spaghetti: flag(d.noodle), cleanBed: flag(d.clean_bed) }
        : { supported: true, enabled: false, spaghetti: false, cleanBed: false };
    }

    // TESPİT SONUCU: `defect_detection` yalnız AYARI yayınlar (canlı doğrulandı — main_enable,
    // noodle/clean_bed/residue/nozzle × {enable, check_window, sensitivity}). Yakalama anında
    // firmware baskıyı durdurup uyarıyı `exception_manager.exceptions` listesine koyar; sebep
    // metni `print_stats.exception` ile aynı sözlükten gelir. Aktif baskıda liste boş olduğu
    // için şema henüz KANITLANAMADI → tanımadığımız alan görürsek bir kez log'a düşürüyoruz.
    const exc = status.exception_manager?.exceptions;
    if (Array.isArray(exc) && exc.length) {
      for (const e of exc) {
        const text = exceptionText(e);
        const id = e && typeof e === "object" ? `${(e as any).id}:${(e as any).code}` : null;
        if (text) {
          out.alerts.push({ code: id, text });
        } else if (id && !loggedUnknownAlert.has(id)) {
          loggedUnknownAlert.add(id);
          console.warn(`[moonraker] tanınmayan yazıcı uyarısı ${id}:`, JSON.stringify(e).slice(0, 400));
        }
      }
    }

    // Buraya gelindiyse yanıt gerçekten çözümlendi. Ayrıştırma ortasında bir şey patlarsa
    // read=false kalır ve yarım tablo "son bilinen"in yerine GEÇMEZ.
    out.read = true;
  } catch {
    /* okunamadıysa varsayılan (hepsi kapalı/boş) döner — uydurma değer yok */
  }
  return out;
}

// ── Timelapse videoları ──────────────────────────────────────────────────
// Snapmaker U1'de standart `moonraker-timelapse` bileşeni KURULU DEĞİL (canlı /server/info ile
// doğrulandı) — Snapmaker kendi timelapse'ini yazıyor ve videoyu `timelapse` kökü yerine
// `camera` köküne (/oem/printer_data/camera) koyuyor. Fluidd/Mainsail yalnız `gcodes`u
// gösterdiği için orada görünmüyor. Yine de her iki kökü de deniyoruz (firmware değişebilir).
const TIMELAPSE_ROOTS = ["camera", "timelapse"] as const;
const VIDEO_RE = /\.(mp4|avi|mov|mkv|webm)$/i;

export interface MoonrakerTimelapse {
  name: string;
  size: number;
  modified: number | null;
  /** Doğrudan indirilebilir/oynatılabilir URL (Moonraker Range destekler → video seek çalışır). */
  url: string;
  /** Aynı adlı kapak görseli varsa (U1 video ile birlikte .jpg yazıyor). */
  thumbUrl: string | null;
}

/** Yazıcıdaki timelapse videoları (+ varsa kapak görseli). Kök yoksa boş dizi döner. */
export async function moonrakerTimelapseList(
  host: string,
  port: number
): Promise<MoonrakerTimelapse[]> {
  const base = await moonrakerBaseFor(host, port);
  const out: MoonrakerTimelapse[] = [];
  for (const root of TIMELAPSE_ROOTS) {
    let rows: { path: string; size: number; modified: number | null }[] = [];
    try {
      const res = await mreq(host, port, `/server/files/list?root=${root}`, undefined, 8000);
      if (!res.ok) continue; // kök kayıtlı değil (400) → sonrakini dene
      const j = unwrap(await res.json()) as any;
      rows = (Array.isArray(j) ? j : []).map((f: any) => ({
        path: String(f?.path ?? ""),
        size: Number(f?.size) || 0,
        modified: Number.isFinite(Number(f?.modified)) ? Number(f.modified) : null,
      }));
    } catch {
      continue; // yazıcı çevrimdışı/erişilemez
    }
    const images = new Set(
      rows.filter((r) => /\.(jpg|jpeg|png)$/i.test(r.path)).map((r) => r.path.replace(/\.[^.]+$/, ""))
    );
    for (const r of rows) {
      if (!r.path || !VIDEO_RE.test(r.path)) continue;
      const stem = r.path.replace(/\.[^.]+$/, "");
      out.push({
        name: r.path,
        size: r.size,
        modified: r.modified,
        url: `${base}/server/files/${root}/${encodeURIComponent(r.path)}`,
        // Hangi kapak? Gerekçesi `timelapseKapakSec` içinde (iki jpg yazılıyor, büyüğü doğru).
        thumbUrl: (() => {
          const kapak = timelapseKapakSec(stem, images);
          return kapak ? `${base}/server/files/${root}/${encodeURIComponent(kapak)}` : null;
        })(),
      });
    }
  }
  // En yeni önce (modified yoksa en sona).
  return out.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
}

/**
 * Timelapse videosunu SİL — yanındaki kapak dosyalarıyla birlikte.
 *
 * Video silinip kapakları kalırsa yazıcının deposunda yetim dosyalar birikir; üstelik
 * liste kapağa bakarak eşleştirme yaptığı için kafa karıştırıcı kayıtlar oluşur.
 * Kapak yoksa hata sayılmaz (her videoda ikisi birden olmayabilir).
 */
export async function moonrakerTimelapseSil(
  host: string,
  port: number,
  name: string,
): Promise<boolean> {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) return false;
  const stem = name.replace(/\.[^.]+$/, "");
  let videoSilindi = false;
  for (const root of TIMELAPSE_ROOTS) {
    for (const dosya of [name, `${stem}.jpg`, `${stem}_cover.jpg`]) {
      try {
        const res = await mreq(
          host, port,
          `/server/files/${root}/${encodeURIComponent(dosya)}`,
          { method: "DELETE" }, 10000,
        );
        if (res.ok && dosya === name) videoSilindi = true;
      } catch { /* sıradaki dosya/kök */ }
    }
    if (videoSilindi) break; // doğru kökü bulduk
  }
  return videoSilindi;
}

// ── PARÇA İPTALİ (exclude_object) ──────────────────────────────────────────
//
// Tablada bozulan tek bir parçanın baskısını atlar; diğerleri devam eder.
// GERİ ALINAMAZ SAYILIR (geri alma yalnız SONRAKİ katmanları kurtarır), o yüzden burada
// üç koruma var ve üçü de ölçülmüş bir tuzağa karşılık geliyor.

/** Tablada duran tek bir nesne — adı, merkezi ve tepeden görünüş poligonu (tabla mm). */
export interface MoonrakerObject {
  name: string;
  center: [number, number];
  polygon: [number, number][];
}


/** Nesne listesi — YALNIZ poligonu ve merkezi olanlar. */
export function gecerliNesneler(ham: unknown): MoonrakerObject[] {
  if (!Array.isArray(ham)) return [];
  const out: MoonrakerObject[] = [];
  for (const o of ham) {
    if (!o || typeof o !== "object") continue;
    const r = o as { name?: unknown; center?: unknown; polygon?: unknown };
    if (typeof r.name !== "string" || !r.name) continue;
    // Klipper, tanımsız bir adla EXCLUDE_OBJECT_START görürse nesneyi YALNIZ isimle listeye
    // ekliyor (poligonsuz). Öyle bir kayıt haritada çizilemez → elenir.
    if (!Array.isArray(r.polygon) || r.polygon.length < 3) continue;
    if (!Array.isArray(r.center) || r.center.length < 2) continue;
    const poly: [number, number][] = [];
    for (const p of r.polygon) {
      if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") {
        poly.push([p[0], p[1]]);
      }
    }
    if (poly.length < 3) continue;
    out.push({
      name: r.name,
      center: [Number(r.center[0]), Number(r.center[1])],
      polygon: poly,
    });
  }
  return out;
}

/**
 * Tabladaki nesneleri TEK SEFER oku (poligonlar dahil, ~3,8 KB). Baskı boyunca değişmez,
 * o yüzden sıcak yoklamaya değil yalnız diyalog açılışına bağlıdır.
 */
export async function fetchMoonrakerObjects(host: string, port: number): Promise<MoonrakerObject[]> {
  try {
    const res = await mreq(host, port, `/printer/objects/query?exclude_object`, undefined, 3000);
    if (!res.ok) return [];
    return gecerliNesneler(unwrap(await res.json())?.status?.exclude_object?.objects);
  } catch {
    return [];
  }
}

/** Yazıcının o anki hariç-tutma durumu (ad doğrulaması ve teyit için). */
async function excludeDurumu(
  host: string,
  port: number,
): Promise<{ objects: string[]; excluded: string[] } | null> {
  try {
    const res = await mreq(
      host, port,
      `/printer/objects/query?exclude_object=objects,excluded_objects`,
      undefined, 2500,
    );
    if (!res.ok) return null;
    const eo = unwrap(await res.json())?.status?.exclude_object;
    if (!eo) return null;
    const objects: string[] = Array.isArray(eo.objects)
      ? eo.objects.map((o: { name?: unknown }) => (typeof o?.name === "string" ? o.name : "")).filter(Boolean)
      : [];
    const excluded: string[] = Array.isArray(eo.excluded_objects)
      ? eo.excluded_objects.filter((x: unknown): x is string => typeof x === "string")
      : [];
    return { objects, excluded };
  } catch {
    return null;
  }
}

/**
 * Bir parçanın baskısını atla.
 *
 * ⚠️ SESSİZ BAŞARISIZLIĞA KARŞI ÇİFT KORUMA. Klipper gönderilen adı KENDİ listesiyle
 * karşılaştırmıyor: uydurma bir ad hatasız kabul edilir, "Excluding object X" yazar ve
 * HİÇBİR ŞEY atlanmaz — kullanıcı iptal ettiğini sanırken parça basılmaya devam eder.
 * Bu yüzden (1) göndermeden ÖNCE ad canlı listede aranır, (2) gönderdikten SONRA
 * `excluded_objects` içinde belirmesi beklenir.
 *
 * ⚠️ CURRENT=1 HİÇ KULLANILMAZ. Nesne nöbeti ölçüldü: 15,87 sn; panelin verisi 5-9 sn bayat.
 * "Şu an basılanı iptal et" iki denemeden birinde YANLIŞ parçayı öldürürdü.
 */
export async function moonrakerExcludeObject(host: string, port: number, name: string): Promise<void> {
  const durum = await excludeDurumu(host, port);
  if (!durum) throw new Error("Yazıcıdan parça listesi okunamadı.");
  if (!durum.objects.includes(name)) {
    throw new Error("Bu parça yazıcının listesinde yok. Sayfayı yenileyip tekrar dene.");
  }
  if (durum.excluded.includes(name)) return; // zaten iptal — sessizce başarılı say

  await moonrakerGcodeScript(host, port, `EXCLUDE_OBJECT NAME=${klipperParamKacisla(name)}`, {
    timeoutMs: 10_000,
    failMessage: "Parça iptal edilemedi.",
  });

  // TEYİT: komut kabul edilmiş olabilir ama hiçbir şey atlamamış olabilir.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const son = await excludeDurumu(host, port);
    if (son?.excluded.includes(name)) return;
  }
  throw new Error("Parça iptal edilemedi. Tekrar dene.");
}

/**
 * Parça iptalini geri al — YALNIZ ADLA.
 *
 * ⚠️ ÇIPLAK `EXCLUDE_OBJECT RESET=1` ASLA GÖNDERİLMEZ: excluded_objects listesini komple
 * boşaltır, yani saatler önce BİLEREK iptal edilmiş tüm parçalar dirilir ve nozul yarım
 * kalmış kütüklerin üstüne dalar.
 *
 * Geri alma yalnız BUNDAN SONRAKİ katmanları kurtarır; atlanmış katmanlar geri gelmez.
 */
export async function moonrakerUnexcludeObject(host: string, port: number, name: string): Promise<void> {
  if (!name) throw new Error("Parça adı gerekli.");
  await moonrakerGcodeScript(
    host, port,
    `EXCLUDE_OBJECT RESET=1 NAME=${klipperParamKacisla(name)}`,
    { timeoutMs: 10_000, failMessage: "Geri alınamadı." },
  );
}
