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
import * as net from "node:net";
import crypto from "node:crypto";

export interface BambuStatus {
  online: boolean;
  gcodeState: string | null;
  percent: number; // 0..100
  remainingSec: number | null;
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
}

/** Bambu HMS girişini ({attr,code}) okunur koda çevir: AAAA-BBBB-CCCC-DDDD (hex). */
function formatHms(attr: number, code: number): string {
  const h = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(4, "0");
  return `${h((attr >>> 16) & 0xffff)}-${h(attr & 0xffff)}-${h((code >>> 16) & 0xffff)}-${h(code & 0xffff)}`;
}

interface Conn {
  client: MqttClient;
  print: Record<string, any>;
  connected: boolean;
  lastError: string | null;
  hasData: boolean; // ilk "report" geldi mi (Object.keys taraması yerine ucuz bayrak)
  lastMessageAt: number; // son report zamanı — veri-bayatlığı bekçisi (çok-istemci açlığı) için
  disconnectedAt: number; // son kopma zamanı — kısa reconnect bloklarında "çevrimdışı" titremesin
  lastPushallAt: number; // pushall istek sıklığı sınırı (A1 donanımı sık pushall sevmez)
}

const conns = new Map<string, Conn>();
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
    lastMessageAt: 0, disconnectedAt: 0, lastPushallAt: 0,
  };
  conns.set(k, conn);

  const reportTopic = `device/${serial}/report`;
  const requestTopic = `device/${serial}/request`;

  client.on("connect", () => {
    conn.connected = true;
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
  if (!hasData) {
    return {
      online: false, gcodeState: null, percent: 0, remainingSec: null,
      layerNum: null, totalLayerNum: null, nozzle: 0, nozzleTarget: 0, bed: 0, bedTarget: 0, filename: null,
      printError: null, hmsCount: 0, hmsCodes: [],
    };
  }
  const hmsArr = Array.isArray(p.hms) ? p.hms : [];
  const hmsCodes = hmsArr
    .map((h: any) => (h && typeof h.attr === "number" && typeof h.code === "number" ? formatHms(h.attr, h.code) : null))
    .filter((x: string | null): x is string => !!x);

  const remainingMin = typeof p.mc_remaining_time === "number" ? p.mc_remaining_time : null;
  return {
    online: true,
    gcodeState: typeof p.gcode_state === "string" ? p.gcode_state : null,
    percent: typeof p.mc_percent === "number" ? p.mc_percent : 0,
    remainingSec: remainingMin != null ? Math.round(remainingMin * 60) : null, // Bambu: DAKİKA
    layerNum: typeof p.layer_num === "number" ? p.layer_num : null,
    totalLayerNum: typeof p.total_layer_num === "number" ? p.total_layer_num : null,
    nozzle: Math.round(p.nozzle_temper ?? 0),
    nozzleTarget: Math.round(p.nozzle_target_temper ?? 0),
    bed: Math.round(p.bed_temper ?? 0),
    bedTarget: Math.round(p.bed_target_temper ?? 0),
    filename: p.subtask_name || p.gcode_file || null,
    printError: typeof p.print_error === "number" ? p.print_error : null,
    hmsCount: hmsArr.length,
    hmsCodes,
  };
}

export function bambuControl(host: string, accessCode: string, serial: string, action: "pause" | "resume" | "cancel"): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = ensureConn(host, accessCode, serial);
    // BAĞLI DEĞİLKEN reddet: mqtt.js QoS-1 publish'i kuyruğa alır → çevrimdışıyken basılan
    // "duraklat" saatler sonra yeniden bağlanınca uygulanabilirdi (bayat komut tehlikesi).
    // Ayrıca eski fire-and-forget hali hatayı hiç bildirmiyordu (kullanıcı "ok" sanıyordu).
    if (!conn.connected) {
      reject(new Error("Yazıcı bağlı değil — komut gönderilemedi"));
      return;
    }
    const command = action === "cancel" ? "stop" : action;
    // QoS 0 (hayalet-komut koruması): QoS 1'de ACK kaybolan duraklat/devam saatler sonra
    // yeniden bağlanınca TEKRAR gönderilirdi (bayat resume = kendi kendine baskı sürdürme).
    // Teslim doğrulaması kullanıcı tarafında: durum 5sn poll'da değişmezse tekrar basar.
    conn.client.publish(
      `device/${serial}/request`,
      JSON.stringify({ print: { sequence_id: "0", command, param: "" } }),
      { qos: 0 },
      (err) => (err ? reject(err) : resolve())
    );
  });
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
  let ctrlErr: Error | null = null;
  let dataErr: Error | null = null;
  let stage = "connect";

  // Kontrol yanıtını oku (FTP final satırı: "NNN <metin>"; çok satırlı yanıtta öncekiler atılır).
  const nextReply = (timeoutMs = 20000): Promise<{ code: number; text: string }> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = setInterval(() => {
        if (ctrlErr) { clearInterval(tick); reject(ctrlErr); return; }
        const m = inbuf.match(/^(\d{3}) ([^\r\n]*)\r?\n/m);
        if (m) {
          clearInterval(tick);
          inbuf = inbuf.slice(inbuf.indexOf(m[0]) + m[0].length);
          resolve({ code: parseInt(m[1], 10), text: m[2] });
        } else if (Date.now() > deadline) {
          clearInterval(tick);
          reject(new Error("kontrol yanıtı zaman aşımı"));
        }
      }, 40);
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
    ctrl.on("data", (d: Buffer) => { inbuf += d.toString("latin1"); });
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
    const CHUNK = 256 * 1024;
    for (let off = 0; off < total; off += CHUNK) {
      if (dataErr) throw dataErr;
      const chunk = fileBuf.subarray(off, Math.min(off + CHUNK, total));
      if (!data.write(chunk)) await onceEvt(data, "drain", 30000, "veri akış");
      onProgress?.(Math.min(99, Math.round(((off + chunk.length) / total) * 100)));
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
  let ctrlErr: Error | null = null;

  const nextReply = (timeoutMs = 15000): Promise<{ code: number; text: string }> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = setInterval(() => {
        if (ctrlErr) { clearInterval(tick); reject(ctrlErr); return; }
        const m = inbuf.match(/^(\d{3}) ([^\r\n]*)\r?\n/m);
        if (m) {
          clearInterval(tick);
          inbuf = inbuf.slice(inbuf.indexOf(m[0]) + m[0].length);
          resolve({ code: parseInt(m[1], 10), text: m[2] });
        } else if (Date.now() > deadline) {
          clearInterval(tick);
          reject(new Error("FTP yanıtı zaman aşımı"));
        }
      }, 40);
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
    ctrl.on("data", (d: Buffer) => { inbuf += d.toString("latin1"); });
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

/** Yazıcı depolamasındaki dosyalar (FTP kökü = dahili eMMC). Klasörler atlanır. */
export async function bambuStorageList(host: string, accessCode: string): Promise<BambuStorageFile[]> {
  return bambuFtpQuery(host, accessCode, async ({ cmd, nextReply, openData, readDataToEnd }) => {
    const d = await openData();
    const r150 = await cmd("LIST");
    if (r150.code >= 400) throw new Error(`LIST reddedildi (${r150.code})`);
    const text = await readDataToEnd(d);
    await nextReply(); // 226
    const files: BambuStorageFile[] = [];
    for (const line of text.split("\n")) {
      // vsftpd biçimi: "-rw-r--r--    1 ftp  ftp   1234567 Jul 08 10:15 dosya.3mf"
      const m = line.match(/^([-dl])[\w-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+[\d:]{4,5})\s+(.+?)\r?$/);
      if (!m || m[1] !== "-") continue; // yalnız normal dosyalar (klasör/link atla)
      const name = m[4].trim();
      if (!name || name === "." || name === "..") continue;
      files.push({ name, size: Number(m[2]) || 0, modified: null });
    }
    files.sort((a, b) => b.size - a.size);
    return files;
  });
}

/** Yazıcı depolamasından dosya sil (yalnız kontrol kanalı — DELE). Silinen sayısını döndürür. */
export async function bambuDeleteFiles(host: string, accessCode: string, names: string[]): Promise<number> {
  if (!names.length) return 0;
  return bambuFtpQuery(host, accessCode, async ({ cmd }) => {
    let ok = 0;
    for (const n of names) {
      if (!n || n.includes("/") || n.includes("\\") || n.startsWith(".")) continue; // yalnız kökteki düz dosyalar
      const r = await cmd(`DELE ${n}`);
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
