/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Bambu Lab LAN MQTT adaptörü — A1 / A1 Combo (ve P/X serisi).
 * Protokol OpenBambuAPI'den doğrulandı:
 *   Bağlantı: mqtts://<ip>:8883  (TLS self-signed → rejectUnauthorized:false)
 *   Kullanıcı: "bblp"  ·  Şifre: yazıcı LAN access code
 *   Subscribe: device/<serial>/report   ·  Publish: device/<serial>/request
 *   Tam durum: { pushing: { sequence_id:"0", command:"pushall", version:1, push_target:1 } }
 *   Kontrol:   { print: { sequence_id:"0", command:"pause|resume|stop", param:"" } }  (QoS 1)
 *   Durum (print.*): gcode_state, mc_percent, mc_remaining_time (DAKİKA),
 *                    layer_num, total_layer_num, nozzle_temper, bed_temper,
 *                    nozzle_target_temper, bed_target_temper, subtask_name / gcode_file
 *
 * MQTT kalıcı bir bağlantı olduğu için, polled API route'unda her seferinde
 * yeniden bağlanmak yerine MODÜL DÜZEYİNDE bir bağlantı havuzu tutulur (Next
 * server Electron main'de tek instance → singleton kalıcı). Yazıcı sürekli
 * "report" push'lar; route sadece bellekteki son durumu okur.
 */
import mqtt, { type MqttClient } from "mqtt";
import * as tls from "node:tls";
import { processSingleton } from "./process-singleton";
import * as net from "node:net";
import crypto from "node:crypto";

export interface BambuStatus {
  online: boolean;
  gcodeState: string | null;
  percent: number; // 0..100
  remainingSec: number | null;
  /** Baskının gerçekten başladığı an (print.gcode_start_time, unix sn) — geçen süre için. */
  startedAtMs: number | null;
  layerNum: number | null;
  totalLayerNum: number | null;
  nozzle: number;
  nozzleTarget: number;
  bed: number;
  bedTarget: number;
  filename: string | null;
  printError: number | null; // print.print_error (0 = sorun yok)
  hmsCount: number; // print.hms[] uzunluğu (aktif uyarı sayısı)
  hmsCodes: string[]; // print.hms[] → okunur HMS kodları (ör. "0700-8001-0002-0008")
  /** Panele düşecek uyarılar — sade Türkçe metin + ham kod (MADDE 14). */
  warnings: BambuWarning[];
  /** Hız profili (1 sessiz · 2 standart · 3 hızlı · 4 çok hızlı). Bilinmiyorsa null. */
  speedLevel: number | null;
  /** AMS'te o an takılı slot (tray_now). 254/255 = harici makara. */
  activeTray: number | null;
  /** Duraklatma/hata NEDENİ — sade Türkçe (yoksa null). */
  statusReason: string | null;
}

export interface BambuWarning {
  /** "0700-8001-0002-0008" — üreticinin HMS kodu (destek araması için). */
  code: string;
  level: "fatal" | "serious" | "common" | "info";
  /** Son kullanıcıya gösterilecek kısa metin. */
  text: string;
}

/** Bambu HMS girişini ({attr,code}) okunur koda çevir: AAAA-BBBB-CCCC-DDDD (hex). */
function formatHms(attr: number, code: number): string {
  const h = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(4, "0");
  return `${h((attr >>> 16) & 0xffff)}-${h(attr & 0xffff)}-${h((code >>> 16) & 0xffff)}-${h(code & 0xffff)}`;
}

const HMS_LEVEL_TEXT: Record<BambuWarning["level"], string> = {
  fatal: "Yazıcı durdu — donanım uyarısı",
  serious: "Yazıcı ciddi bir uyarı veriyor",
  common: "Yazıcı uyarı veriyor",
  info: "Yazıcı bilgi veriyor",
};

/** HMS kodunun ilk 4 hanesi hangi birimden geldiğini söyler — kullanıcıya ANLAMLI kısım budur. */
function hmsModuleText(code: string): string | null {
  const head = code.slice(0, 4).toUpperCase();
  if (head === "0700" || head === "0701") return "Baskı kafası";
  if (head === "0300") return "AMS / filament";
  if (head === "0500") return "Tabla";
  if (head === "1200") return "Ana kart";
  return null;
}

/** HMS girişini kullanıcı diline çevir. Kod bilinmiyorsa uydurmuyoruz: birim + önem düzeyi. */
function toWarning(attr: number, code: number): BambuWarning {
  const text = formatHms(attr, code);
  const sev = (code >>> 16) & 0xffff;
  const level: BambuWarning["level"] =
    sev === 1 ? "fatal" : sev === 2 ? "serious" : sev === 3 ? "common" : "info";
  // Değişken adı `module` OLAMAZ — Next derlemesi bunu hata sayıyor (@next/next/no-assign-module-variable).
  const part = hmsModuleText(text);
  return { code: text, level, text: part ? `${part} — ${HMS_LEVEL_TEXT[level]}` : HMS_LEVEL_TEXT[level] };
}

interface Conn {
  client: MqttClient;
  print: Record<string, any>;
  connected: boolean;
  lastError: string | null;
  hasData: boolean; // ilk "report" geldi mi (Object.keys taraması yerine ucuz bayrak)
  lastMessageAt: number; // son report zamanı — veri-bayatlığı bekçisi (çok-istemci açlığı) için
  disconnectedAt: number; // son kopma zamanı — kısa reconnect bloklarında "çevrimdışı" titremesin
  connectedAt: number; // son BAŞARILI bağlanma zamanı — "bağlandı ama hiç veri gelmedi" bekçisi için
  lastPushallAt: number; // pushall istek sıklığı sınırı (A1 donanımı sık pushall sevmez)
}

/**
 * Bağlantı havuzu SÜREÇ GENELİNDE tektir (`globalThis`) — modül kapsamında DEĞİL.
 * Sebebi ve ölçümü: `process-singleton.ts`. Kısaca: bu dosya iki ayrı pakete kopyalanıyordu,
 * her kopya kendi havuzunu açıyordu ve yazıcıya iki MQTT istemcisi bağlanıyordu; Bambu yalnız
 * son bağlanana veri gönderdiği için iki kopya birbirini susturup sonsuz gel-git yaratıyordu.
 */
const conns = processSingleton("bambuConns", () => new Map<string, Conn>());
// accessCode anahtarın PARÇASI: kod değişince eski bağlantı (bayat şifreyle sonsuz reconnect
// deneyen) kapatılıp yenisi kurulur. Eski davranış: yanlış/eski kod uygulama yeniden
// başlatılana dek geçerli kalıyordu.
const connKey = (host: string, serial: string, accessCode: string) => `${host}|${serial}|${accessCode}`;

/** Bir yazıcının MQTT bağlantısını kapat + havuzdan düş (config silme/düzenleme sonrası zombie
 *  reconnect kalmasın). host/serial eşleşen TÜM anahtarlar (eski access code'lular dahil) düşer. */
export function dropBambuConns(host: string, serial: string): void {
  const prefix = `${host}|${serial}|`;
  for (const [k, c] of conns) {
    if (k.startsWith(prefix)) {
      try { c.client.end(true); } catch { /* kapanışta hata önemsiz */ }
      conns.delete(k);
    }
  }
}

function ensureConn(host: string, accessCode: string, serial: string): Conn {
  const k = connKey(host, serial, accessCode);
  const existing = conns.get(k);
  if (existing) return existing;
  // Aynı yazıcı için FARKLI access code'lu eski bağlantı varsa kapat (kod güncellendi).
  for (const [ok, oc] of conns) {
    if (ok.startsWith(`${host}|${serial}|`) && ok !== k) {
      try { oc.client.end(true); } catch { /* kapanışta hata önemsiz */ }
      conns.delete(ok);
    }
  }

  const client = mqtt.connect(`mqtts://${host}:8883`, {
    username: "bblp",
    password: accessCode,
    rejectUnauthorized: false,
    reconnectPeriod: 5000,
    connectTimeout: 8000,
    keepalive: 30,
    clientId: `mg3d_${Math.random().toString(16).slice(2, 10)}`,
    // Bağlantı yokken publish KUYRUĞA ALINMAZ (hayalet-komut koruması): varsayılan true,
    // kopukken yayınlanan komutu bellekte tutup yeniden bağlanınca gönderiyordu.
    queueQoSZero: false,
  });

  const conn: Conn = {
    client, print: {}, connected: false, lastError: null, hasData: false,
    lastMessageAt: 0, disconnectedAt: 0, connectedAt: 0, lastPushallAt: 0,
  };
  conns.set(k, conn);

  const reportTopic = `device/${serial}/report`;
  const requestTopic = `device/${serial}/request`;

  client.on("connect", () => {
    conn.connected = true;
    conn.connectedAt = Date.now();
    conn.lastError = null;
    // HAYALET-KOMUT SİGORTASI: bağlantı anında bekleyen (kuyruklanmış) publish varsa TEMİZLE —
    // hiçbir komut gecikmeli teslim edilmemeli (2023 Bambu bulut kesintisindeki dünya çapında
    // hayalet baskılar bu sınıftandı). queueQoSZero:false + QoS 0 zaten engelliyor; bu son perde.
    try {
      const q = (client as unknown as { queue?: unknown[] }).queue;
      if (Array.isArray(q) && q.length > 0) {
        console.warn(`[bambu] bağlantıda ${q.length} bekleyen mesaj TEMİZLENDİ (gecikmeli teslim engellendi)`);
        q.length = 0;
      }
    } catch { /* iç yapı değişmişse sessiz geç */ }
    client.subscribe(reportTopic, { qos: 0 });
    conn.lastPushallAt = Date.now();
    client.publish(
      requestTopic,
      JSON.stringify({ pushing: { sequence_id: "0", command: "pushall", version: 1, push_target: 1 } }),
      { qos: 0 }
    );
  });
  // Her yeniden bağlanma DENEMESİNDE eski hatayı temizle — bayat lastError, sağlıklı reconnect
  // sürerken ilk-veri beklemesini kalıcı kısa devre yapıp yazıcıyı sürekli "çevrimdışı" gösteriyordu.
  client.on("reconnect", () => { conn.lastError = null; });
  client.on("message", (_topic, payload) => {
    try {
      const msg = JSON.parse(payload.toString());
      if (msg?.print && typeof msg.print === "object") {
        // YENİ İŞ BAŞLADI (subtask_name değişti) → önceki işin bayat alanlarını temizle.
        // Artımlı merge yüzünden eski işin percent/layer/remaining değerleri yeni dosya adıyla
        // birlikte bir-iki poll boyunca raporlanabiliyordu; baskı sırasında bu alanlar ~1sn'de
        // bir yeniden gelir, kısa boşluk zararsız.
        const newTask = typeof msg.print.subtask_name === "string" ? msg.print.subtask_name : null;
        const oldTask = typeof conn.print.subtask_name === "string" ? conn.print.subtask_name : null;
        if (newTask && oldTask && newTask !== oldTask) {
          delete conn.print.mc_percent;
          delete conn.print.mc_remaining_time;
          delete conn.print.layer_num;
          delete conn.print.total_layer_num;
          delete conn.print.print_error;
        }
        // Bambu artımlı (yalnızca değişen alanlar) gönderir → birleştir. Aynı anahtarlar üzerine
        // yazılır (sınırsız büyümez); ams/hms gibi diziler referansla değişir.
        Object.assign(conn.print, msg.print);
        conn.hasData = true;
        conn.lastMessageAt = Date.now();
      }
    } catch {
      /* JSON olmayan mesajları yok say */
    }
  });
  client.on("error", (err: Error) => { conn.lastError = err?.message || "mqtt hata"; });
  client.on("close", () => { conn.connected = false; conn.disconnectedAt = Date.now(); });
  client.on("offline", () => { conn.connected = false; conn.disconnectedAt = Date.now(); });

  return conn;
}

export async function getBambuStatus(host: string, accessCode: string, serial: string): Promise<BambuStatus> {
  const conn = ensureConn(host, accessCode, serial);

  // İlk bağlantıda ilk "report" gelene kadar kısa bekle (en fazla ~2.2sn).
  // Bağlantı hatası (yanlış kod / kapalı yazıcı) gelirse beklemeyi ERKEN kes —
  // çevrimdışı yazıcı her sorguda 2.2sn yakmasın.
  if (!conn.hasData) {
    // ⚠️ KURTARMA (kök neden düzeltmesi): pushall QoS 0 ile "ateşle-unut" gönderiliyor ve
    // ESKİDEN yalnız bağlantı anında BİR KEZ atılıyordu. O tek paket kaybolursa (kablosuz,
    // yazıcı meşgul, firmware'in "son istemci kazanır" davranışı) yazıcı kendiliğinden rapor
    // göndermediği sürece hasData HİÇ true olmuyordu. Aşağıdaki bayatlık bekçisi de
    // `hasData` ŞARTINA bağlı olduğu için hiç çalışmıyor → kart SÜRESİZ "Bağlantı yok"ta
    // kalıyordu; uygulamayı kapatıp açmak yalnızca YENİ pushall tuttuğunda düzeltiyordu
    // ("bazen düzeliyor bazen düzelmiyor" şikâyetinin birebir sebebi).
    // Çözüm: bağlıyken ve hâlâ veri yokken pushall'ı TEKRARLA (≥4sn arayla — A1 sık pushall
    // sevmez; panel 5sn'de bir yokladığı için pratikte her yoklamada bir deneme olur).
    if (conn.connected && Date.now() - conn.lastPushallAt > 4_000) {
      conn.lastPushallAt = Date.now();
      try {
        conn.client.publish(
          `device/${serial}/request`,
          JSON.stringify({ pushing: { sequence_id: "0", command: "pushall", version: 1, push_target: 1 } }),
          { qos: 0 } // QoS 0 KALSIN: QoS 1'in yeniden teslimi v0.19.96'daki hayalet-baskıya yol açmıştı
        );
      } catch { /* yayın başarısızsa sonraki yoklama tekrar dener */ }
    }
    // İKİNCİ PERDE: bağlıyız, defalarca pushall istedik ama 45sn'dir HİÇ rapor yok → büyük
    // olasılıkla Bambu Studio/Handy bağlandı ve firmware "son istemci kazanır" ile bizi susturdu
    // (BambuStudio#2404). Çare, hasData=true dalında zaten kullanılan yöntem: bağlantıyı düşür,
    // sonraki sorgu taze kurar → YENİDEN son istemci biz oluruz ve veri geri gelir.
    if (conn.connected && conn.connectedAt > 0 && Date.now() - conn.connectedAt > 45_000) {
      try { conn.client.end(true); } catch { /* ignore */ }
      conns.delete(connKey(host, serial, accessCode));
      // Bu sorgu çevrimdışı döner (aşağıdaki hasData kontrolü zaten false); SONRAKİ sorgu
      // taze bağlantı kurup pushall'ı yeniden ister.
    }
    const deadline = Date.now() + 2200;
    while (Date.now() < deadline && !conn.hasData) {
      if (conn.lastError) break;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const p = conn.print;
  const now = Date.now();

  // VERİ-BAYATLIĞI BEKÇİSİ (Bambu firmware "SON istemci kazanır": Studio/Handy bağlanırsa biz
  // bağlı kalırız ama rapor almayı KESERİZ — BambuStudio#2404). Bağlıyız ama uzun süredir rapor
  // yoksa: önce nazikçe pushall iste (≥5dk arayla — A1 sık pushall sevmez), hâlâ sessizse
  // bağlantıyı yenile (yeniden bağlanan son istemci oluruz → veri geri gelir).
  if (conn.connected && conn.hasData && conn.lastMessageAt > 0) {
    const stale = now - conn.lastMessageAt;
    if (stale > 6 * 60_000) {
      try { conn.client.end(true); } catch { /* ignore */ }
      conns.delete(connKey(host, serial, accessCode)); // sonraki sorgu taze bağlantı kurar
    } else if (stale > 2 * 60_000 && now - conn.lastPushallAt > 5 * 60_000) {
      conn.lastPushallAt = now;
      try {
        conn.client.publish(
          `device/${serial}/request`,
          JSON.stringify({ pushing: { sequence_id: "0", command: "pushall", version: 1, push_target: 1 } }),
          { qos: 0 }
        );
      } catch { /* ignore */ }
    }
  }

  // ONLINE (debounce'lu): veri gelmiş VE (bağlı YA DA kopalı ≤15sn — reconnect penceresi).
  // Eski hali `connected` anlık false olunca hemen "çevrimdışı" diyordu; mqtt.js her yeniden
  // bağlanma denemesinde close/offline yayar → 5-10sn'lik ağ dalgalanması 30sn'lik önbellek
  // backoff'uyla birleşip kartı uzun uzun "Bağlantı yok"ta tutuyordu (pybambu deseni: kısa
  // kopuşta son bilinen durumla devam, kalıcı kopuşta dürüst çevrimdışı).
  const hasData = conn.hasData && (conn.connected || now - conn.disconnectedAt < 15_000);
  if (!hasData) return offlineBambuStatus();

  const hmsArr = Array.isArray(p.hms) ? p.hms : [];
  const warnings: BambuWarning[] = hmsArr
    .map((h: any) => (h && typeof h.attr === "number" && typeof h.code === "number" ? toWarning(h.attr, h.code) : null))
    .filter((x: BambuWarning | null): x is BambuWarning => !!x);

  const remainingMin = typeof p.mc_remaining_time === "number" ? p.mc_remaining_time : null;
  const startSec = Number(p.gcode_start_time);
  const gcodeState = typeof p.gcode_state === "string" ? p.gcode_state : null;
  const printError = typeof p.print_error === "number" ? p.print_error : null;
  const trayNow = Number(p.ams?.tray_now);
  return {
    online: true,
    gcodeState,
    percent: typeof p.mc_percent === "number" ? p.mc_percent : 0,
    remainingSec: remainingMin != null ? Math.round(remainingMin * 60) : null, // Bambu: DAKİKA
    startedAtMs: Number.isFinite(startSec) && startSec > 1_000_000_000 ? startSec * 1000 : null,
    layerNum: typeof p.layer_num === "number" ? p.layer_num : null,
    totalLayerNum: typeof p.total_layer_num === "number" ? p.total_layer_num : null,
    nozzle: Math.round(p.nozzle_temper ?? 0),
    nozzleTarget: Math.round(p.nozzle_target_temper ?? 0),
    bed: Math.round(p.bed_temper ?? 0),
    bedTarget: Math.round(p.bed_target_temper ?? 0),
    filename: p.subtask_name || p.gcode_file || null,
    printError,
    hmsCount: hmsArr.length,
    hmsCodes: warnings.map((w) => w.code),
    warnings,
    speedLevel: typeof p.spd_lvl === "number" ? p.spd_lvl : null,
    activeTray: Number.isFinite(trayNow) && trayNow >= 0 && trayNow < 250 ? trayNow : null,
    statusReason: bambuStatusReason(gcodeState, printError, warnings),
  };
}

function offlineBambuStatus(): BambuStatus {
  return {
    online: false, gcodeState: null, percent: 0, remainingSec: null, startedAtMs: null,
    layerNum: null, totalLayerNum: null, nozzle: 0, nozzleTarget: 0, bed: 0, bedTarget: 0, filename: null,
    printError: null, hmsCount: 0, hmsCodes: [], warnings: [], speedLevel: null, activeTray: null,
    statusReason: null,
  };
}

/**
 * MADDE 14 — "neden durdu / ne uyarıyor" panele düşsün.
 * Bambu düz metin sebep vermiyor; elimizde hata kodu ve HMS uyarıları var. En ciddi uyarıyı
 * öne çıkarıp sade Türkçe tek satır üretiyoruz (kod, ayrı alanda zaten duruyor).
 */
function bambuStatusReason(
  gcodeState: string | null,
  printError: number | null,
  warnings: BambuWarning[],
): string | null {
  const order: BambuWarning["level"][] = ["fatal", "serious", "common", "info"];
  const top = order.map((lvl) => warnings.find((w) => w.level === lvl)).find(Boolean) ?? null;
  const state = (gcodeState || "").toUpperCase();
  if (state === "FAILED") {
    return top ? `Baskı hatayla durdu · ${top.text}` : "Baskı hatayla durdu";
  }
  if (state === "PAUSE") {
    if (top) return `Duraklatıldı · ${top.text}`;
    if (printError) return "Duraklatıldı — yazıcı bir sorun bildirdi";
    return null; // kullanıcı elle duraklatmış olabilir; uydurma sebep yazma
  }
  // NORMAL DURUMDA sebep yazma. HMS listesinde kalıcı düşük önemli girişler (ör. boş AMS slotu)
  // duruyor; bunları `statusReason` yapmak sorunsuz basan yazıcı için telefonda kalıcı sahte
  // uyarı üretiyordu. Uyarılar zaten ayrı `warnings[]` dizisinde gidiyor.
  if (top && (top.level === "fatal" || top.level === "serious")) return top.text;
  return null;
}

/** Komuttan sonra yazıcının olması gereken gcode_state değerleri. */
const BAMBU_EXPECTED_STATES: Record<"pause" | "resume" | "cancel", string[]> = {
  pause: ["PAUSE"],
  resume: ["RUNNING", "PREPARE", "SLICING"],
  cancel: ["IDLE", "FINISH", "FAILED"],
};
const BAMBU_ACTION_LABEL: Record<"pause" | "resume" | "cancel", string> = {
  pause: "Duraklatma", resume: "Devam ettirme", cancel: "İptal",
};
/** Durum değişimi için tanınan süre — A1 rapor aralığı ~1sn, iptal makrosu daha uzun sürer. */
const BAMBU_VERIFY_MS: Record<"pause" | "resume" | "cancel", number> = {
  pause: 12_000, resume: 12_000, cancel: 20_000,
};

/**
 * Komut GÖNDERİLMEDEN ÖNCE yazıcının olması gereken durumları.
 * Bambu firmware "son istemci kazanır" ile bizi susturduğunda `conn.print` önceki işten kalma
 * değerde DONUYOR. Ön koşul olmadan boşta/bitmiş bir yazıcıya "İptal" gönderiliyor, donmuş
 * "FINISH" değeri beklenen listede olduğu için de anında "iptal edildi" deniyordu.
 */
const BAMBU_REQUIRED_STATES: Record<"pause" | "resume" | "cancel", string[]> = {
  pause: ["RUNNING", "PREPARE", "SLICING"],
  resume: ["PAUSE"],
  cancel: ["RUNNING", "PREPARE", "SLICING", "PAUSE"],
};

const BAMBU_NOT_APPLICABLE: Record<"pause" | "resume" | "cancel", string> = {
  pause: "Duraklatma yapılamadı — yazıcı şu an basmıyor.",
  resume: "Devam ettirme yapılamadı — duraklatılmış bir baskı yok.",
  cancel: "İptal yapılamadı — süren bir baskı yok.",
};

/** Rapor bu süreden eskiyse yazıcının bildirdiği duruma GÜVENİLMEZ (susturulmuş olabiliriz). */
const BAMBU_FRESH_MS = 20_000;

/** Tam durum isteği — beş çağrı yeriyle AYNI biçim (`version`/`push_target` şart). */
function publishPushall(conn: Conn, serial: string): void {
  try {
    conn.client.publish(
      `device/${serial}/request`,
      JSON.stringify({ pushing: { sequence_id: "0", command: "pushall", version: 1, push_target: 1 } }),
      { qos: 0 }
    );
    conn.lastPushallAt = Date.now();
  } catch { /* gitmezse normal raporlar zaten gelecek */ }
}

export interface BambuControlResult {
  verified: boolean;
  state: string | null;
}

/**
 * MADDE 9 — Duraklat / devam / iptal ve KOMUTUN UYGULANDIĞININ DOĞRULANMASI.
 *
 * Eski davranış: publish geri çağrısı hatasız dönünce başarı sayılıyordu. MQTT QoS 0'da bu
 * yalnız "paket sokete yazıldı" demektir — yazıcı komutu reddetse bile arayüz "Duraklatıldı"
 * yazıyordu. Artık komuttan sonra yazıcının BİLDİRDİĞİ durum beklenir; geçmezse net hata döner.
 */
export async function bambuControl(
  host: string,
  accessCode: string,
  serial: string,
  action: "pause" | "resume" | "cancel",
): Promise<BambuControlResult> {
  const conn = ensureConn(host, accessCode, serial);
  // BAĞLI DEĞİLKEN reddet: mqtt.js QoS-1 publish'i kuyruğa alır → çevrimdışıyken basılan
  // "duraklat" saatler sonra yeniden bağlanınca uygulanabilirdi (bayat komut tehlikesi).
  if (!conn.connected) throw new Error("Yazıcı bağlı değil — komut gönderilmedi.");

  // TAZELİK: `conn.print` yalnız MQTT raporu geldiğinde tazelenir ve yeniden bağlanmada
  // TEMİZLENMEZ. Bayat durum üzerinden komut yollamak ya da doğrulamak, olmamış bir işlemi
  // "başarılı" gösteriyordu. Önce tam durum iste, kısa süre bekle; hâlâ taze veri yoksa net hata.
  if (!conn.hasData || Date.now() - conn.lastMessageAt > BAMBU_FRESH_MS) {
    publishPushall(conn, serial);
    const wait = Date.now() + 3000;
    while (Date.now() < wait && (!conn.hasData || Date.now() - conn.lastMessageAt > BAMBU_FRESH_MS)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!conn.hasData || Date.now() - conn.lastMessageAt > BAMBU_FRESH_MS) {
      throw new Error("Yazıcı şu an durumunu bildirmiyor — komut gönderilmedi.");
    }
  }

  const stateBefore = typeof conn.print.gcode_state === "string" ? conn.print.gcode_state.toUpperCase() : null;
  if (!stateBefore || !BAMBU_REQUIRED_STATES[action].includes(stateBefore)) {
    throw new Error(BAMBU_NOT_APPLICABLE[action]);
  }
  // Doğrulama YALNIZ bu damgadan SONRA gelen raporlara bakar — komut öncesi durum "doğrulama"
  // sayılmaz.
  const sentAfterMs = conn.lastMessageAt;

  const command = action === "cancel" ? "stop" : action;
  // QoS 0 (hayalet-komut koruması): QoS 1'de ACK kaybolan duraklat/devam saatler sonra
  // yeniden bağlanınca TEKRAR gönderilirdi (bayat resume = kendi kendine baskı sürdürme).
  await new Promise<void>((resolve, reject) => {
    conn.client.publish(
      `device/${serial}/request`,
      JSON.stringify({ print: { sequence_id: "0", command, param: "" } }),
      { qos: 0 },
      (err) => {
        if (!err) { resolve(); return; }
        console.warn(`[bambu] ${action} publish hatası:`, err);
        reject(new Error(`${BAMBU_ACTION_LABEL[action]} komutu yazıcıya iletilemedi.`));
      }
    );
  });
  // A1/P1 delta raporlar; durum geçişini beklemeden görebilmek için tam durum iste.
  publishPushall(conn, serial);

  const expected = BAMBU_EXPECTED_STATES[action];
  const deadline = Date.now() + BAMBU_VERIFY_MS[action];
  for (;;) {
    const state = typeof conn.print.gcode_state === "string" ? conn.print.gcode_state.toUpperCase() : null;
    // Rapor KOMUTTAN SONRA gelmiş olmalı: eski (donmuş) durum doğrulama sayılmaz.
    if (conn.lastMessageAt > sentAfterMs && state && expected.includes(state)) return { verified: true, state };
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${BAMBU_ACTION_LABEL[action]} komutu gönderildi ama yazıcı uygulamadı — ekranını kontrol et.`);
}

/**
 * MADDE 10 — Bambu'da hız "profil" ile ayarlanır (serbest yüzde yok):
 *   1 sessiz (%50) · 2 standart (%100) · 3 hızlı (%124) · 4 çok hızlı (%166)
 * Komut: `{ print: { command: "print_speed", param: "<1-4>" } }`. Uygulandığı `spd_lvl`'den doğrulanır.
 */
export const BAMBU_SPEED_LEVELS: readonly { level: number; label: string; pct: number }[] = [
  { level: 1, label: "Sessiz", pct: 50 },
  { level: 2, label: "Standart", pct: 100 },
  { level: 3, label: "Hızlı", pct: 124 },
  { level: 4, label: "Çok hızlı", pct: 166 },
];

export async function bambuSetSpeedLevel(
  host: string, accessCode: string, serial: string, level: number,
): Promise<number> {
  if (!BAMBU_SPEED_LEVELS.some((l) => l.level === level)) {
    throw new Error("Geçersiz hız profili.");
  }
  const conn = ensureConn(host, accessCode, serial);
  if (!conn.connected) throw new Error("Yazıcı bağlı değil — komut gönderilmedi.");
  await new Promise<void>((resolve, reject) => {
    conn.client.publish(
      `device/${serial}/request`,
      JSON.stringify({ print: { sequence_id: "0", command: "print_speed", param: String(level) } }),
      { qos: 0 },
      (err) => {
        if (!err) { resolve(); return; }
        console.warn("[bambu] print_speed publish hatası:", err);
        reject(new Error("Hız değiştirilemedi."));
      }
    );
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (typeof conn.print.spd_lvl === "number" && conn.print.spd_lvl === level) return level;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("Hız komutu gönderildi ama yazıcı yeni değeri uygulamadı.");
}

/**
 * Yazıcının bir SONRAKİ raporunu bekler (en fazla `tavanMs`).
 *
 * Baskı doğrulaması eskiden her turda körlemesine 1600 ms uyuyordu; A1 saniyede bir rapor
 * bastığı için bu, hiçbir işe yaramadan garanti gecikme demekti. Şimdi rapor gelir gelmez
 * devam ediliyor. Damga karşılaştırması korunuyor: komuttan ÖNCEKİ (bayat) durum okunursa
 * döngü "yazıcı reddetti" diye yanlış alarm veriyordu.
 *
 * Bağlantı yoksa/rapor gelmezse tavana kadar bekler — yani en kötü ihtimalde eski davranış.
 */
export async function bambuRaporBekle(
  host: string,
  accessCode: string,
  serial: string,
  sonrasi: number,
  tavanMs: number,
): Promise<number> {
  const conn = ensureConn(host, accessCode, serial);
  const bitis = Date.now() + tavanMs;
  while (Date.now() < bitis) {
    if (conn.lastMessageAt > sonrasi) return conn.lastMessageAt;
    await new Promise((r) => setTimeout(r, 80));
  }
  return conn.lastMessageAt;
}


export interface BambuSlot { slot: number; color: string; type: string; remain: number | null; empty: boolean }

function hexFromBambu(c?: unknown): string {
  if (typeof c === "string" && c.replace(/[^0-9a-fA-F]/g, "").length >= 6) return `#${c.slice(0, 6)}`;
  return "#9ca3af";
}

/** AMS slotları (numara + renk + materyal) — baskı öncesi yüklü filamentleri göstermek için. */
export async function getBambuAmsSlots(host: string, accessCode: string, serial: string): Promise<BambuSlot[]> {
  const conn = ensureConn(host, accessCode, serial);
  // TAZELİK: renk-eşleme ekranı her açıldığında makinedeki GÜNCEL AMS renkleri görünmeli.
  // Bağlıysak ve son tam-durum eskiyse pushall iste (≤60sn'de bir — A1 sık pushall sevmez;
  // aradaki filament değişiklikleri zaten delta raporla anında düşer) ve taze raporu kısaca bekle.
  if (conn.connected && conn.hasData && Date.now() - conn.lastPushallAt > 60_000) {
    conn.lastPushallAt = Date.now();
    const askedAt = Date.now();
    try {
      conn.client.publish(
        `device/${serial}/request`,
        JSON.stringify({ pushing: { sequence_id: "0", command: "pushall", version: 1, push_target: 1 } }),
        { qos: 0 }
      );
    } catch { /* istek gitmezse eldeki veriyle devam */ }
    const freshDeadline = Date.now() + 1200;
    while (Date.now() < freshDeadline && conn.lastMessageAt < askedAt) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  if (!conn.print?.ams) {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !conn.print?.ams) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  const units = conn.print?.ams?.ams;
  if (!Array.isArray(units)) return [];
  const slots: BambuSlot[] = [];
  for (const unit of units) {
    const trays = Array.isArray(unit?.tray) ? unit.tray : [];
    for (const t of trays) {
      const idNum = Number(t?.id);
      const type = typeof t?.tray_type === "string" ? t.tray_type : "";
      slots.push({
        slot: Number.isFinite(idNum) ? idNum : slots.length,
        color: hexFromBambu(t?.tray_color),
        type,
        remain: typeof t?.remain === "number" ? t.remain : null,
        empty: !type,
      });
    }
  }
  return slots;
}

/** Bir soket olayını promise'e çevir (timeout + tek seferlik error guard ile). */
function onceEvt(em: NodeJS.EventEmitter, ev: string, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { cleanup(); reject(new Error(`${label} zaman aşımı`)); }, timeoutMs);
    const ok = () => { cleanup(); resolve(); };
    const er = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => { clearTimeout(to); em.removeListener(ev, ok); em.removeListener("error", er); };
    em.once(ev, ok);
    em.once("error", er);
  });
}

/** Türkçe/özel karakterleri temizleyip güvenli ASCII uzak dosya adı üretir.
 *  ".gcode.3mf" → ".3mf". stem = yazıcının subtask_name olarak raporladığı ad (ürün eşleştirme anahtarı). */
const TR_MAP: Record<string, string> = { "ç": "c", "Ç": "C", "ğ": "g", "Ğ": "G", "ı": "i", "İ": "I", "ö": "o", "Ö": "O", "ş": "s", "Ş": "S", "ü": "u", "Ü": "U" };
function safeRemoteName(original: string): { remote: string; stem: string } {
  const low = original.toLowerCase();
  const ext = low.endsWith(".gcode.3mf") || low.endsWith(".3mf") ? ".3mf"
    : low.endsWith(".gcode") ? ".gcode"
    : low.endsWith(".gco") ? ".gco"
    : low.endsWith(".g") ? ".g"
    : (original.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "");
  const cutLen = low.endsWith(".gcode.3mf") ? ".gcode.3mf".length : ext.length;
  let stem = original.slice(0, original.length - cutLen);
  stem = stem.replace(/[çÇğĞıİöÖşŞüÜ]/g, (ch) => TR_MAP[ch] ?? ch);
  stem = stem.normalize("NFKD").replace(/[^\x20-\x7E]/g, "");
  stem = stem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[_.-]+|[_.-]+$/g, "");
  if (!stem) stem = "print";
  return { remote: `${stem}${ext}`, stem };
}

/**
 * Bambu deposuna (A1: dahili eMMC = FTP kökü) implicit FTPS (990) ile RAW Node-`tls` upload.
 * basic-ftp'nin upload yolu Bambu vsftpd ile çalışmıyordu: LIST/indirme TLS-1.2 ile çalışıyor ama
 * STOR/yükleme veri bağlantısı asılıyor (basic-ftp upload'ta data secureConnect'i kendi akışında
 * bekliyor; vsftpd ssl_session_reuse + implicit data ile uyumsuz). Bu yüzden soketleri elle sürüyoruz:
 *   - Kontrol: implicit TLS 1.2 (vsftpd ssl_session_reuse_required), self-signed cert.
 *   - PASV → port'u al, host'u YOK SAY (0.0.0.0 olabilir) → bilinen yazıcı IP'sine bağlan.
 *   - Veri soketi: kontrol TLS OTURUMUNU yeniden kullan (session) → vsftpd kabul eder.
 *   - STOR → 150 → veriyi parça parça yaz (onProgress) → 226.
 * Access code asla loglanmaz (trace'te PASS***).
 */
async function bambuFtpUpload(
  host: string,
  accessCode: string,
  fileBuf: Buffer,
  remoteName: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  const trace: string[] = [];
  const total = fileBuf.length;
  const baseTls: tls.ConnectionOptions = { rejectUnauthorized: false, minVersion: "TLSv1.2", maxVersion: "TLSv1.2", servername: host };
  let ctrl: tls.TLSSocket | null = null;
  let dataPlain: net.Socket | null = null;
  let data: tls.TLSSocket | null = null;
  let inbuf = "";
  let ctrlUyandir: (() => boolean) | null = null;
  let ctrlErr: Error | null = null;
  let dataErr: Error | null = null;
  let stage = "connect";

  // Kontrol yanıtını oku (FTP final satırı: "NNN <metin>"; çok satırlı yanıtta öncekiler atılır).
  const nextReply = (timeoutMs = 20000): Promise<{ code: number; text: string }> =>
    new Promise((resolve, reject) => {
      /**
       * ⚠️ 40 ms'lik yoklama DEĞİL, olay tabanlı. Ölçüldü (20 Ağu 2026): yanıt başına 42-48 ms,
       * oysa yazıcıya gidiş-dönüş 3-5 ms — aradaki fark tamamen yoklama aralığıydı. Bir yükleme
       * yedi yanıt bekliyor, yani her baskıda boşa giden ~0,3 sn.
       */
      let zamanlayici: ReturnType<typeof setTimeout> | null = null;
      const bitir = () => {
        if (zamanlayici) clearTimeout(zamanlayici);
        ctrlUyandir = null;
      };
      const dene = (): boolean => {
        if (ctrlErr) { bitir(); reject(ctrlErr); return true; }
        const m = inbuf.match(/^(\d{3}) ([^\r\n]*)\r?\n/m);
        if (!m) return false;
        bitir();
        inbuf = inbuf.slice(inbuf.indexOf(m[0]) + m[0].length);
        resolve({ code: parseInt(m[1], 10), text: m[2] });
        return true;
      };
      // Veri zaten tampondaysa beklemeden dön; değilse soket olayı uyandırsın.
      if (dene()) return;
      zamanlayici = setTimeout(() => {
        bitir();
        reject(new Error("kontrol yanıtı zaman aşımı"));
      }, timeoutMs);
      ctrlUyandir = dene;
    });

  const cmd = async (line: string, label?: string): Promise<{ code: number; text: string }> => {
    if (!ctrl) throw new Error("kontrol soketi yok");
    ctrl.write(line + "\r\n");
    const r = await nextReply();
    trace.push(`${label ?? line.split(" ")[0]}»${r.code}`);
    return r;
  };

  try {
    ctrl = tls.connect({ ...baseTls, host, port: 990 });
    ctrl.on("error", (e: Error) => { ctrlErr = e; });
    ctrl.on("data", (d: Buffer) => { inbuf += d.toString("latin1"); ctrlUyandir?.(); });
    await onceEvt(ctrl, "secureConnect", 15000, "kontrol TLS");
    ctrl.setTimeout(0);
    await nextReply(); // 220 karşılama
    stage = "login";
    if ((await cmd("USER bblp")).code >= 400) throw new Error("USER reddedildi");
    if ((await cmd(`PASS ${accessCode}`, "PASS***")).code >= 400) throw new Error("login reddedildi (access code?)");
    await cmd("TYPE I");
    stage = "pasv";
    const pasv = await cmd("PASV");
    const mm = pasv.text.match(/(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/);
    if (!mm) throw new Error("PASV ayrıştırılamadı");
    const dataPort = (+mm[5]) * 256 + (+mm[6]);
    trace.push(`DATA→${host}:${dataPort}`); // PASV host'u (0.0.0.0 olabilir) YOK SAYILIR
    stage = "data-conn";
    dataPlain = net.connect(dataPort, host);
    dataPlain.on("error", (e: Error) => { dataErr = e; });
    await onceEvt(dataPlain, "connect", 15000, "veri soketi");
    stage = "data-tls";
    // Veri soketini kontrol TLS OTURUMUYLA sar (vsftpd oturum yeniden kullanımı şart koşuyor).
    data = tls.connect({
      ...baseTls,
      socket: dataPlain,
      session: ctrl.getSession() ?? undefined,
      secureContext: tls.createSecureContext({ minVersion: "TLSv1.2", maxVersion: "TLSv1.2" }),
    });
    data.on("error", (e: Error) => { dataErr = e; });
    await onceEvt(data, "secureConnect", 15000, "veri TLS");
    trace.push(`DATA-TLS${data.isSessionReused() ? "+reuse" : ""}`);
    stage = "stor";
    ctrl.write(`STOR ${remoteName}\r\n`);
    const r150 = await nextReply();
    trace.push(`STOR»${r150.code}`);
    if (r150.code >= 400) throw new Error(`STOR reddedildi (${r150.code})`);
    stage = "upload";
    /**
     * Ölçüldü: Bambu'nun FTP'si 183 KB/sn veriyor — yazıcının kendi sınırı, hızlandıramayız.
     * Ama 256 KB'lık parçalarla ilerleme çubuğu 1,6 MB'lık dosyada yalnız 7 kez sıçrıyordu.
     * Küçük parça hızı değiştirmez, çubuğu akıtır. Yüzde DEĞİŞMEDİKÇE olay gönderilmez —
     * dev dosyada binlerce gereksiz mesaj birikmesin.
     */
    const CHUNK = 32 * 1024;
    let sonPct = -1;
    for (let off = 0; off < total; off += CHUNK) {
      if (dataErr) throw dataErr;
      const chunk = fileBuf.subarray(off, Math.min(off + CHUNK, total));
      if (!data.write(chunk)) await onceEvt(data, "drain", 30000, "veri akış");
      const pct = Math.min(99, Math.round(((off + chunk.length) / total) * 100));
      if (pct !== sonPct) { sonPct = pct; onProgress?.(pct); }
    }
    data.end();
    await onceEvt(data, "close", 30000, "veri kapanış");
    data = null;
    const done = await nextReply(30000); // 226 Transfer complete
    trace.push(`DONE»${done.code}`);
    if (done.code >= 400) throw new Error(`transfer tamamlanmadı (${done.code})`);
    onProgress?.(100);
    try { ctrl.write("QUIT\r\n"); } catch { /* yoksay */ }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    console.error(`[bambu-ftp] ${host} ${stage} basarisiz: ${raw} · iz: ${trace.join(" ")}`);
    const userMsg = stage === "connect" || stage === "login"
      ? "Yazıcıya FTP bağlantısı kurulamadı (TLS / port 990 / access code)."
      : "Dosya yazıcıya yüklenemedi (veri bağlantısı).";
    throw new Error(`${userMsg} · iz: ${trace.join(" ")}`);
  } finally {
    try { data?.destroy(); } catch { /* yoksay */ }
    try { dataPlain?.destroy(); } catch { /* yoksay */ }
    try { ctrl?.destroy(); } catch { /* yoksay */ }
  }
}

/**
 * SIZE/DELE/LIST için HAFİF FTP oturumu — kanıtlanmış upload istemcisine DOKUNMADAN ayrı, küçük
 * istemci (aynı TLS 1.2 + oturum-yeniden-kullanım kuralları). SIZE ve DELE yalnız kontrol kanalı
 * kullanır (veri bağlantısı YOK — en güvenli); LIST tek veri bağlantısı açar (ilk veri bağlantısı
 * kontrol oturumunu yeniden kullanır — v0.19.2'de doğrulanan çalışan desen).
 */
async function bambuFtpQuery<T>(
  host: string,
  accessCode: string,
  run: (io: {
    cmd: (line: string, label?: string) => Promise<{ code: number; text: string }>;
    nextReply: (timeoutMs?: number) => Promise<{ code: number; text: string }>;
    openData: () => Promise<tls.TLSSocket>;
    readDataToEnd: (d: tls.TLSSocket, timeoutMs?: number) => Promise<string>;
  }) => Promise<T>
): Promise<T> {
  const baseTls: tls.ConnectionOptions = { rejectUnauthorized: false, minVersion: "TLSv1.2", maxVersion: "TLSv1.2", servername: host };
  let ctrl: tls.TLSSocket | null = null;
  let dataPlain: net.Socket | null = null;
  let data: tls.TLSSocket | null = null;
  let inbuf = "";
  let ctrlUyandir: (() => boolean) | null = null;
  let ctrlErr: Error | null = null;

  const nextReply = (timeoutMs = 15000): Promise<{ code: number; text: string }> =>
    new Promise((resolve, reject) => {
      /**
       * ⚠️ 40 ms'lik yoklama DEĞİL, olay tabanlı. Ölçüldü (20 Ağu 2026): yanıt başına 42-48 ms,
       * oysa yazıcıya gidiş-dönüş 3-5 ms — aradaki fark tamamen yoklama aralığıydı. Bir yükleme
       * yedi yanıt bekliyor, yani her baskıda boşa giden ~0,3 sn.
       */
      let zamanlayici: ReturnType<typeof setTimeout> | null = null;
      const bitir = () => {
        if (zamanlayici) clearTimeout(zamanlayici);
        ctrlUyandir = null;
      };
      const dene = (): boolean => {
        if (ctrlErr) { bitir(); reject(ctrlErr); return true; }
        const m = inbuf.match(/^(\d{3}) ([^\r\n]*)\r?\n/m);
        if (!m) return false;
        bitir();
        inbuf = inbuf.slice(inbuf.indexOf(m[0]) + m[0].length);
        resolve({ code: parseInt(m[1], 10), text: m[2] });
        return true;
      };
      // Veri zaten tampondaysa beklemeden dön; değilse soket olayı uyandırsın.
      if (dene()) return;
      zamanlayici = setTimeout(() => {
        bitir();
        reject(new Error("FTP yanıtı zaman aşımı"));
      }, timeoutMs);
      ctrlUyandir = dene;
    });

  const cmd = async (line: string): Promise<{ code: number; text: string }> => {
    if (!ctrl) throw new Error("kontrol soketi yok");
    ctrl.write(line + "\r\n");
    return nextReply();
  };

  const openData = async (): Promise<tls.TLSSocket> => {
    const pasv = await cmd("PASV");
    const mm = pasv.text.match(/(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/);
    if (!mm) throw new Error("PASV ayrıştırılamadı");
    const dataPort = (+mm[5]) * 256 + (+mm[6]); // host YOK SAYILIR (0.0.0.0 olabilir)
    dataPlain = net.connect(dataPort, host);
    await onceEvt(dataPlain, "connect", 10000, "veri soketi");
    data = tls.connect({
      ...baseTls,
      socket: dataPlain,
      session: ctrl!.getSession() ?? undefined,
      secureContext: tls.createSecureContext({ minVersion: "TLSv1.2", maxVersion: "TLSv1.2" }),
    });
    await onceEvt(data, "secureConnect", 10000, "veri TLS");
    return data;
  };

  const readDataToEnd = (d: tls.TLSSocket, timeoutMs = 20000): Promise<string> =>
    new Promise((resolve, reject) => {
      let out = "";
      const to = setTimeout(() => reject(new Error("veri okuma zaman aşımı")), timeoutMs);
      d.on("data", (c: Buffer) => { out += c.toString("latin1"); });
      d.once("close", () => { clearTimeout(to); resolve(out); });
      d.once("error", (e: Error) => { clearTimeout(to); reject(e); });
    });

  try {
    ctrl = tls.connect({ ...baseTls, host, port: 990 });
    ctrl.on("error", (e: Error) => { ctrlErr = e; });
    ctrl.on("data", (d: Buffer) => { inbuf += d.toString("latin1"); ctrlUyandir?.(); });
    await onceEvt(ctrl, "secureConnect", 10000, "kontrol TLS");
    ctrl.setTimeout(0);
    await nextReply(); // 220
    if ((await cmd("USER bblp")).code >= 400) throw new Error("USER reddedildi");
    if ((await cmd(`PASS ${accessCode}`)).code >= 400) throw new Error("FTP girişi reddedildi (access code?)");
    await cmd("TYPE I");
    const result = await run({ cmd, nextReply, openData, readDataToEnd });
    try { ctrl.write("QUIT\r\n"); } catch { /* yoksay */ }
    return result;
  } finally {
    // (cast: data/dataPlain closure içinde atanıyor — TS akış analizi burada null sanıyor)
    try { (data as tls.TLSSocket | null)?.destroy(); } catch { /* yoksay */ }
    try { (dataPlain as net.Socket | null)?.destroy(); } catch { /* yoksay */ }
    try { ctrl?.destroy(); } catch { /* yoksay */ }
  }
}

/** Yazıcıdaki dosyanın boyutu (yalnız kontrol kanalı — SIZE). Yoksa/hata → null. */
export async function bambuRemoteFileSize(
  host: string,
  accessCode: string,
  uploadName: string
): Promise<{ remote: string; stem: string; size: number | null }> {
  const { remote, stem } = safeRemoteName(uploadName);
  const size = await bambuFtpQuery(host, accessCode, async ({ cmd }) => {
    const r = await cmd(`SIZE ${remote}`);
    if (r.code !== 213) return null;
    const n = Number(r.text.trim());
    return Number.isFinite(n) ? n : null;
  }).catch(() => null);
  return { remote, stem, size };
}

export interface BambuStorageFile { name: string; size: number; modified: number | null }

// A1 kullanıcı baskı dosyalarını /cache'te tutar (kök dizinde YALNIZ klasörler var: logger,
// recorder, cache, model, image, ipcam, timelapse...). Canlı FTP tanılamasıyla doğrulandı:
// kökte LIST → 8 klasör (hepsi elenir → "0 dosya" bug'ı); /cache'te → gerçek baskı dosyaları.
const BAMBU_FILES_DIR = "cache";

const LS_LINE = /^([-dl])[\w.+-]{9,}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+[\d:]{4,5})\s+(.+?)\r?$/;

/** Yazıcı depolamasındaki baskı dosyaları. Asıl konum /cache; kök de taranır (uygulamanın
 *  STOR ettiği artıklar orada olabilir). Ad çakışırsa /cache kazanır. Klasörler atlanır. */
export async function bambuStorageList(host: string, accessCode: string): Promise<BambuStorageFile[]> {
  return bambuFtpQuery(host, accessCode, async ({ cmd, nextReply, openData, readDataToEnd }) => {
    const seen = new Map<string, BambuStorageFile>();
    for (const dir of [BAMBU_FILES_DIR, "/"]) { // önce /cache (öncelik) sonra kök
      try {
        const d = await openData();
        const r150 = await cmd(`LIST ${dir}`); // AÇIK yol — bare LIST bazı ftpd'lerde farklı davranır
        if (r150.code >= 400) continue;
        const text = await readDataToEnd(d);
        await nextReply(); // 226
        for (const line of text.split("\n")) {
          const m = LS_LINE.exec(line);
          if (!m || m[1] !== "-") continue; // yalnız normal dosyalar (klasör/link atla)
          const name = m[4].trim();
          if (!name || name === "." || name === ".." || seen.has(name)) continue;
          seen.set(name, { name, size: Number(m[2]) || 0, modified: null });
        }
      } catch { /* dizin yok/erişilemedi → atla */ }
    }
    return [...seen.values()].sort((a, b) => b.size - a.size);
  });
}

/** Yazıcı depolamasından dosya sil (yalnız kontrol kanalı — DELE). Önce /cache, olmazsa kök
 *  denenir (dosya iki yerden birinde). Silinen sayısını döndürür. */
export async function bambuDeleteFiles(host: string, accessCode: string, names: string[]): Promise<number> {
  if (!names.length) return 0;
  return bambuFtpQuery(host, accessCode, async ({ cmd }) => {
    let ok = 0;
    for (const n of names) {
      if (!n || n.includes("/") || n.includes("\\") || n.startsWith(".")) continue; // yalnız düz dosya adları
      let r = await cmd(`DELE ${BAMBU_FILES_DIR}/${n}`); // önce /cache
      if (r.code >= 400) r = await cmd(`DELE ${n}`);     // yoksa kök
      if (r.code < 400) ok++;
    }
    return ok;
  });
}

/**
 * Bambu'da baskı başlat: PREFLIGHT (durum/IDLE) → güvenli ad → FTPS yükle+doğrula → MQTT.
 *  .3mf → project_file (plate + ams_mapping, url ftp:///<ad>); .gcode → gcode_file (ham, /<ad>).
 * A1'de SD yok → dosya FTP kökünde (dahili eMMC), url ftp şeması. bed_leveling tek-L (firmware böyle bekliyor).
 * Döndürür { matchName }: yazıcının subtask_name olarak raporlayacağı ad (ürün eşleştirme anahtarı).
 */
export async function bambuUploadAndPrint(
  host: string,
  accessCode: string,
  serial: string,
  fileBuf: Buffer,
  originalName: string,
  opts: { amsMapping?: number[]; useAms?: boolean; plateParam?: string; onProgress?: (pct: number) => void; prefs?: { timelapse?: boolean; bedLeveling?: boolean; flowCali?: boolean } } = {}
): Promise<{ matchName: string }> {
  // PREFLIGHT: yazıcı çevrimiçi + boşta mı? (UI butonu gizlese de 2. istemci / bayat poll'a karşı sunucu kontrolü)
  const pre = await getBambuStatus(host, accessCode, serial);
  if (!pre.online) throw new Error("Yazıcıya bağlanılamadı (MQTT). IP ve access code'u kontrol edin.");
  const preState = mapBambuState(pre.gcodeState);
  if (preState === "printing" || preState === "paused") {
    throw new Error("Yazıcı şu an meşgul (baskı sürüyor veya duraklatılmış).");
  }

  const isGcode = /\.(gcode|gco|g)$/i.test(originalName) && !/\.3mf$/i.test(originalName);
  const { remote: remoteName, stem } = safeRemoteName(originalName);

  await bambuFtpUpload(host, accessCode, fileBuf, remoteName, opts.onProgress);

  const conn = ensureConn(host, accessCode, serial);
  const fileMd5 = crypto.createHash("md5").update(fileBuf).digest("hex");
  const payload = buildBambuStartPayload(remoteName, stem, isGcode, fileMd5, opts);
  await publishBambuStart(conn, serial, payload);

  return { matchName: stem };
}

/** Bambu baskı-başlat MQTT payload'u — upload sonrası VE yazıcıda-hazır (reuse) yolunun ORTAK üreticisi. */
function buildBambuStartPayload(
  remoteName: string,
  stem: string,
  isGcode: boolean,
  fileMd5: string,
  opts: { amsMapping?: number[]; useAms?: boolean; plateParam?: string; prefs?: { timelapse?: boolean; bedLeveling?: boolean; flowCali?: boolean } }
): Record<string, unknown> {
  return isGcode
    ? { print: { sequence_id: "0", command: "gcode_file", param: `/${remoteName}` } }
    : {
        print: {
          sequence_id: "0",
          command: "project_file",
          // GERÇEK plate gcode yolu (Studio gibi) — sabit plate_1 değil; yanlışsa A1 reddeder.
          param: opts.plateParam || "Metadata/plate_1.gcode",
          project_id: "0", profile_id: "0", task_id: "0", subtask_id: "0",
          subtask_name: stem,
          file: "",
          url: `ftp:///${remoteName}`,
          md5: fileMd5,
          timelapse: opts.prefs?.timelapse ?? false, bed_type: "auto", bed_leveling: opts.prefs?.bedLeveling ?? false,
          flow_cali: opts.prefs?.flowCali ?? false, vibration_cali: false, layer_inspect: false,
          // ams_mapping: TÜM proje filamentleri üzerinden, kullanılmayan = -1 (route'ta dolduruldu).
          ams_mapping: opts.amsMapping ?? [0],
          use_ams: opts.useAms ?? false,
        },
      };
}

/** Baskı-başlat komutunu güvenle yayınla (upload + reuse yollarının ORTAK son adımı).
 *  🔴 HAYALET BASKI FIX: baskı-başlat ASLA QoS 1 olamaz. QoS 1'de ACK (PUBACK) kaybolursa
 *  mqtt.js mesajı bellekte tutar ve HER yeniden bağlanışta TEKRAR GÖNDERİR (DUP) → uyku/uyanma
 *  sonrası "son dosya kendi kendine baştan basılıyor" (sahada yaşandı). QoS 0 = protokol
 *  seviyesinde YENİDEN İLETİM YOK; teslim doğrulaması print route'un durum-izleme döngüsünde.
 *  FTP upload dakikalar sürebildiği için yayınlamadan önce bağlantı + meşguliyet YENİDEN kontrol edilir. */
async function publishBambuStart(conn: Conn, serial: string, payload: Record<string, unknown>): Promise<void> {
  try {
    console.error("[bambu-print] payload:", JSON.stringify((payload as any).print));
  } catch { /* log atla */ }
  if (!conn.connected) {
    throw new Error("Yazıcı bağlantısı koptu — baskı komutu gönderilmedi, tekrar dene.");
  }
  const liveState = mapBambuState(typeof conn.print.gcode_state === "string" ? conn.print.gcode_state : null);
  if (liveState === "printing" || liveState === "paused") {
    throw new Error("Yazıcı bu sırada başka bir baskıya başladı — komut gönderilmedi.");
  }
  await new Promise<void>((resolve, reject) => {
    conn.client.publish(`device/${serial}/request`, JSON.stringify(payload), { qos: 0 }, (err) =>
      err ? reject(new Error(`Baskı komutu gönderilemedi: ${err.message}`)) : resolve()
    );
  });
  // A1/P1 seyrek (delta) raporlar → durum geçişini görebilmek için tam durum iste.
  conn.client.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }), { qos: 0 });
}

/**
 * Yazıcıda ZATEN duran (içerik-hash'li adla yüklenmiş) dosyayı indirmeden/yüklemeden başlat.
 * Kimlik: ad içindeki MD5 + SIZE eşleşmesi route'ta doğrulandı; md5 DB'den gelir (payload için).
 */
export async function bambuStartExisting(
  host: string,
  accessCode: string,
  serial: string,
  uploadName: string,
  opts: { md5: string; amsMapping?: number[]; useAms?: boolean; plateParam?: string; prefs?: { timelapse?: boolean; bedLeveling?: boolean; flowCali?: boolean } }
): Promise<{ matchName: string }> {
  const pre = await getBambuStatus(host, accessCode, serial);
  if (!pre.online) throw new Error("Yazıcıya bağlanılamadı (MQTT). IP ve access code'u kontrol edin.");
  const preState = mapBambuState(pre.gcodeState);
  if (preState === "printing" || preState === "paused") {
    throw new Error("Yazıcı şu an meşgul (baskı sürüyor veya duraklatılmış).");
  }
  const isGcode = /\.(gcode|gco|g)$/i.test(uploadName) && !/\.3mf$/i.test(uploadName);
  const { remote, stem } = safeRemoteName(uploadName);
  const conn = ensureConn(host, accessCode, serial);
  const payload = buildBambuStartPayload(remote, stem, isGcode, opts.md5, opts);
  await publishBambuStart(conn, serial, payload);
  return { matchName: stem };
}

/** gcode_state → panel durumu. */
export function mapBambuState(state: string | null): "printing" | "finished" | "idle" | "paused" | "error" {
  switch ((state || "").toUpperCase()) {
    case "RUNNING":
    case "PREPARE":
    case "SLICING":
      return "printing";
    case "PAUSE":
      return "paused";
    case "FINISH":
      return "finished";
    case "FAILED":
      return "error";
    default:
      return "idle"; // IDLE, vb.
  }
}

// ── Timelapse videoları ──────────────────────────────────────────────────
// Bambu timelapse'i FTP kökündeki `timelapse` klasörüne yazar (canlı FTPS LIST ile doğrulandı:
// 3 video + `thumbnail` alt klasörü). NOT: `ipcam` klasörü SÜREKLİ kamera kaydıdır (onlarca GB
// olabilir) — timelapse DEĞİL, bilerek dışarıda bırakıldı.
// Format .avi: tarayıcı <video> ile OYNATAMAZ → arayüzde yalnız indirme sunulur.
const BAMBU_TIMELAPSE_DIR = "timelapse";
const BAMBU_VIDEO_RE = /\.(avi|mp4|mov|mkv)$/i;

export interface BambuTimelapse {
  name: string;
  size: number;
  /** LIST'ten gelen ham tarih metni ("Feb 10 21:51") — yıl içermeyebilir. */
  modifiedText: string | null;
}

/**
 * Timelapse videosunu SİL — küçük resmiyle birlikte.
 *
 * Bambu videoların küçük resmini `timelapse/thumbnail/<ad>.jpg` olarak yazıyor; video
 * silinip o kalırsa yazıcıda yetim dosyalar birikir. Küçük resmin silinememesi hata
 * sayılmaz (her videonun kapağı olmayabilir).
 */
export async function bambuTimelapseSil(
  host: string,
  accessCode: string,
  name: string,
): Promise<boolean> {
  // Yalnız düz dosya adı — dizin geçişine izin verme.
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) return false;
  return bambuFtpQuery(host, accessCode, async ({ cmd }) => {
    const r = await cmd(`DELE ${BAMBU_TIMELAPSE_DIR}/${name}`);
    if (r.code >= 400) return false;
    const kapak = name.replace(/\.[^.]+$/, ".jpg");
    try { await cmd(`DELE ${BAMBU_TIMELAPSE_DIR}/thumbnail/${kapak}`); } catch { /* kapak yoksa sorun değil */ }
    return true;
  });
}

/** Yazıcıdaki timelapse videoları (yalnız /timelapse; klasörler ve kamera kayıtları hariç). */
export async function bambuTimelapseList(
  host: string,
  accessCode: string
): Promise<BambuTimelapse[]> {
  return bambuFtpQuery(host, accessCode, async ({ cmd, nextReply, openData, readDataToEnd }) => {
    const out: BambuTimelapse[] = [];
    try {
      const d = await openData();
      const r = await cmd(`LIST ${BAMBU_TIMELAPSE_DIR}`);
      if (r.code >= 400) return out;
      const text = await readDataToEnd(d);
      await nextReply(); // 226
      for (const line of text.split("\n")) {
        const m = LS_LINE.exec(line);
        if (!m || m[1] !== "-") continue; // klasörleri (thumbnail) atla
        const name = m[4].trim();
        if (!name || !BAMBU_VIDEO_RE.test(name)) continue;
        out.push({ name, size: Number(m[2]) || 0, modifiedText: m[3] ?? null });
      }
    } catch {
      /* klasör yok / erişilemedi → boş liste */
    }
    // Ad zaman damgası içeriyor (video_2026-02-10_18-33-42.avi) → ada göre tersten = en yeni önce.
    return out.sort((a, b) => b.name.localeCompare(a.name));
  });
}

/**
 * Timelapse videosunu AKIŞ olarak indir (FTPS RETR → web ReadableStream).
 *
 * Neden akış: Bambu'nun FTP'si yavaş (ÖLÇÜLDÜ: 4.5MB ≈ 34sn) ve videolar 55MB'ı bulabiliyor.
 * Tüm dosyayı belleğe alıp öyle göndermek (a) ana süreçte onlarca MB tutuyor, (b) tarayıcı
 * transferi ancak bittiğinde görüyor → ilerleme çubuğu 0'da donup sona 100'e sıçrıyordu.
 * Akışla byte'lar geldikçe iletilir; kullanıcı GERÇEK yüzdeyi görür.
 *
 * Soket ömrü: bambuFtpQuery callback dönünce soketleri kapattığı için burada BAĞIMSIZ bir
 * bağlantı kurulur; akış bitince, hata olunca veya iptal edilince temizlenir.
 */
export async function bambuStreamTimelapse(
  host: string,
  accessCode: string,
  name: string,
  /** "video" = /timelapse/<ad> · "thumb" = /timelapse/thumbnail/<ad>.jpg (kapak, ~100KB). */
  kind: "video" | "thumb" = "video"
): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }> {
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error("Geçersiz dosya adı");
  }
  // Kapak, videoyla AYNI adı taşır (uzantı .jpg) ve `thumbnail` alt klasöründedir — canlı FTPS
  // listesiyle doğrulandı. Kapak sayesinde kullanıcı 50MB'lık videoyu indirmeden ne olduğunu görür.
  const remotePath =
    kind === "thumb"
      ? `${BAMBU_TIMELAPSE_DIR}/thumbnail/${name.replace(/\.[^.]+$/, "")}.jpg`
      : `${BAMBU_TIMELAPSE_DIR}/${name}`;
  const baseTls: tls.ConnectionOptions = {
    rejectUnauthorized: false, minVersion: "TLSv1.2", maxVersion: "TLSv1.2", servername: host,
  };
  let inbuf = "";
  let ctrlUyandir: (() => boolean) | null = null;
  let ctrlErr: Error | null = null;
  const ctrl = tls.connect({ ...baseTls, host, port: 990 });
  ctrl.on("error", (e: Error) => { ctrlErr = e; });
  ctrl.on("data", (d: Buffer) => { inbuf += d.toString("latin1"); ctrlUyandir?.(); });

  const nextReply = (timeoutMs = 15000): Promise<{ code: number; text: string }> =>
    new Promise((resolve, reject) => {
      /**
       * ⚠️ 40 ms'lik yoklama DEĞİL, olay tabanlı. Ölçüldü (20 Ağu 2026): yanıt başına 42-48 ms,
       * oysa yazıcıya gidiş-dönüş 3-5 ms — aradaki fark tamamen yoklama aralığıydı. Bir yükleme
       * yedi yanıt bekliyor, yani her baskıda boşa giden ~0,3 sn.
       */
      let zamanlayici: ReturnType<typeof setTimeout> | null = null;
      const bitir = () => {
        if (zamanlayici) clearTimeout(zamanlayici);
        ctrlUyandir = null;
      };
      const dene = (): boolean => {
        if (ctrlErr) { bitir(); reject(ctrlErr); return true; }
        const m = inbuf.match(/^(\d{3}) ([^\r\n]*)\r?\n/m);
        if (!m) return false;
        bitir();
        inbuf = inbuf.slice(inbuf.indexOf(m[0]) + m[0].length);
        resolve({ code: parseInt(m[1], 10), text: m[2] });
        return true;
      };
      // Veri zaten tampondaysa beklemeden dön; değilse soket olayı uyandırsın.
      if (dene()) return;
      zamanlayici = setTimeout(() => {
        bitir();
        reject(new Error("FTP yanıtı zaman aşımı"));
      }, timeoutMs);
      ctrlUyandir = dene;
    });
  const cmd = async (line: string) => { ctrl.write(line + "\r\n"); return nextReply(); };

  let dataPlain: net.Socket | null = null;
  let data: tls.TLSSocket | null = null;
  const cleanup = () => {
    try { data?.destroy(); } catch { /* yoksay */ }
    try { dataPlain?.destroy(); } catch { /* yoksay */ }
    try { ctrl.write("QUIT\r\n"); } catch { /* yoksay */ }
    try { ctrl.destroy(); } catch { /* yoksay */ }
  };

  try {
    await onceEvt(ctrl, "secureConnect", 10000, "kontrol TLS");
    ctrl.setTimeout(0);
    await nextReply(); // 220
    if ((await cmd("USER bblp")).code >= 400) throw new Error("USER reddedildi");
    if ((await cmd(`PASS ${accessCode}`)).code >= 400) throw new Error("FTP girişi reddedildi (access code?)");
    await cmd("TYPE I");

    // Boyut (Content-Length → tarayıcı gerçek yüzde gösterir). Desteklenmezse null.
    let size: number | null = null;
    const sz = await cmd(`SIZE ${remotePath}`);
    if (sz.code < 400) {
      const n = parseInt(sz.text.trim(), 10);
      if (Number.isFinite(n) && n > 0) size = n;
    }

    const pasv = await cmd("PASV");
    const mm = pasv.text.match(/(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/);
    if (!mm) throw new Error("PASV ayrıştırılamadı");
    dataPlain = net.connect((+mm[5]) * 256 + (+mm[6]), host);
    await onceEvt(dataPlain, "connect", 10000, "veri soketi");
    data = tls.connect({
      ...baseTls, socket: dataPlain, session: ctrl.getSession() ?? undefined,
      secureContext: tls.createSecureContext({ minVersion: "TLSv1.2", maxVersion: "TLSv1.2" }),
    });
    await onceEvt(data, "secureConnect", 10000, "veri TLS");

    const r = await cmd(`RETR ${remotePath}`);
    if (r.code >= 400) throw new Error(`Video okunamadı (FTP ${r.code})`);

    const sock = data;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sock.on("data", (c: Buffer) => {
          try { controller.enqueue(new Uint8Array(c)); } catch { /* kapanmış */ }
        });
        sock.once("close", () => { try { controller.close(); } catch { /* zaten kapalı */ } cleanup(); });
        sock.once("error", (e: Error) => { try { controller.error(e); } catch { /* yoksay */ } cleanup(); });
      },
      cancel() { cleanup(); }, // kullanıcı indirmeyi iptal etti → soketleri bırak
    });
    return { stream, size };
  } catch (e) {
    cleanup();
    throw e;
  }
}
