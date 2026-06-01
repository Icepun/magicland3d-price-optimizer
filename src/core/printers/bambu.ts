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
import { Client as FtpClient, enterPassiveModeIPv4 } from "basic-ftp";
import { Readable } from "node:stream";
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
}

interface Conn {
  client: MqttClient;
  print: Record<string, any>;
  connected: boolean;
  lastError: string | null;
}

const conns = new Map<string, Conn>();
const connKey = (host: string, serial: string) => `${host}|${serial}`;

function ensureConn(host: string, accessCode: string, serial: string): Conn {
  const k = connKey(host, serial);
  const existing = conns.get(k);
  if (existing) return existing;

  const client = mqtt.connect(`mqtts://${host}:8883`, {
    username: "bblp",
    password: accessCode,
    rejectUnauthorized: false,
    reconnectPeriod: 5000,
    connectTimeout: 8000,
    keepalive: 30,
    clientId: `mg3d_${Math.random().toString(16).slice(2, 10)}`,
  });

  const conn: Conn = { client, print: {}, connected: false, lastError: null };
  conns.set(k, conn);

  const reportTopic = `device/${serial}/report`;
  const requestTopic = `device/${serial}/request`;

  client.on("connect", () => {
    conn.connected = true;
    conn.lastError = null;
    client.subscribe(reportTopic, { qos: 0 });
    client.publish(
      requestTopic,
      JSON.stringify({ pushing: { sequence_id: "0", command: "pushall", version: 1, push_target: 1 } }),
      { qos: 0 }
    );
  });
  client.on("message", (_topic, payload) => {
    try {
      const msg = JSON.parse(payload.toString());
      if (msg?.print && typeof msg.print === "object") {
        // Bambu artımlı (yalnızca değişen alanlar) gönderir → birleştir.
        Object.assign(conn.print, msg.print);
      }
    } catch {
      /* JSON olmayan mesajları yok say */
    }
  });
  client.on("error", (err: Error) => { conn.lastError = err?.message || "mqtt hata"; });
  client.on("close", () => { conn.connected = false; });
  client.on("offline", () => { conn.connected = false; });

  return conn;
}

export async function getBambuStatus(host: string, accessCode: string, serial: string): Promise<BambuStatus> {
  const conn = ensureConn(host, accessCode, serial);

  // İlk bağlantıda ilk "report" gelene kadar kısa bekle (en fazla ~2.2sn).
  if (Object.keys(conn.print).length === 0) {
    const deadline = Date.now() + 2200;
    while (Date.now() < deadline && Object.keys(conn.print).length === 0) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const p = conn.print;
  const hasData = Object.keys(p).length > 0;
  if (!hasData) {
    return {
      online: false, gcodeState: null, percent: 0, remainingSec: null,
      layerNum: null, totalLayerNum: null, nozzle: 0, nozzleTarget: 0, bed: 0, bedTarget: 0, filename: null,
      printError: null, hmsCount: 0,
    };
  }

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
    hmsCount: Array.isArray(p.hms) ? p.hms.length : 0,
  };
}

export function bambuControl(host: string, accessCode: string, serial: string, action: "pause" | "resume" | "cancel"): void {
  const conn = ensureConn(host, accessCode, serial);
  const command = action === "cancel" ? "stop" : action;
  conn.client.publish(
    `device/${serial}/request`,
    JSON.stringify({ print: { sequence_id: "0", command, param: "" } }),
    { qos: 1 }
  );
}

export interface BambuSlot { slot: number; color: string; type: string; remain: number | null; empty: boolean }

function hexFromBambu(c?: unknown): string {
  if (typeof c === "string" && c.replace(/[^0-9a-fA-F]/g, "").length >= 6) return `#${c.slice(0, 6)}`;
  return "#9ca3af";
}

/** AMS slotları (numara + renk + materyal) — baskı öncesi yüklü filamentleri göstermek için. */
export async function getBambuAmsSlots(host: string, accessCode: string, serial: string): Promise<BambuSlot[]> {
  const conn = ensureConn(host, accessCode, serial);
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

/** "::ffff:192.168.1.13" / "192.168.1.13" → "192.168.1.13" (yoksa null). */
function controlHostV4(addr: unknown): string | null {
  if (typeof addr !== "string") return null;
  const m = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  return m ? m[1] : null;
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
 * Bambu SD kartına FTP (implicit TLS 990, bblp + access code) ile dosya yükle.
 *
 * Bambu'nun FTP sunucusunun İKİ hatası "Timeout (control socket)" olarak görünür:
 *   1) EPSV'ye yanıt vermez → basic-ftp önce EPSV dener, kontrol soketi timeout olur.
 *      ÇÖZÜM: prepareTransfer'ı doğrudan PASV'a sabitle (EPSV'yi atla).
 *   2) PASV yanıtında host olarak 0.0.0.0 döndürür → veri bağlantısı (Windows'ta loopback'e
 *      gidip) asılır, kontrol soketi timeout olur. ÇÖZÜM: PASV yanıtındaki host'u
 *      YAPILANDIRILMIŞ yazıcı IP'siyle değiştir (socket.remoteAddress boş gelebiliyor → ona güvenme).
 * onProgress: yükleme yüzdesi (0..100). Hata olursa FTP konuşma dökümünü mesaja ekle.
 */
async function bambuFtpUpload(
  host: string,
  accessCode: string,
  fileBuf: Buffer,
  remoteName: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  const ftp = new FtpClient(45000);
  ftp.ftp.verbose = false;
  const ctx = ftp.ftp as unknown as {
    request: (cmd: string) => Promise<{ code: number; message: string }>;
    socket: { remoteAddress?: string };
  };
  const trace: string[] = [];
  const total = fileBuf.length;
  // Yapılandırılmış host IPv4 ise onu kullan (kesin); değilse kontrol soketinin IP'sine düş.
  const hostV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ? host : null;
  const origRequest = ctx.request.bind(ctx);
  ctx.request = (cmd: string) =>
    origRequest(cmd).then(
      (res) => {
        if (typeof cmd === "string" && /^\s*PASV/i.test(cmd) && typeof res?.message === "string") {
          const target = hostV4 || controlHostV4(ctx.socket && ctx.socket.remoteAddress);
          if (target) {
            // "227 ... (0,0,0,0,193,52)" → host oktetlerini yazıcı IP'siyle değiştir, portu koru
            res.message = res.message.replace(
              /(\d{1,3},\d{1,3},\d{1,3},\d{1,3})(\s*,\s*\d{1,3}\s*,\s*\d{1,3})/,
              `${target.replace(/\./g, ",")}$2`
            );
          }
          const mm = res.message.match(/(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/);
          if (mm) trace.push(`DATA→${mm[1]}.${mm[2]}.${mm[3]}.${mm[4]}:${(+mm[5]) * 256 + (+mm[6])}`);
        }
        const safe = /^\s*PASS/i.test(String(cmd)) ? "PASS***" : String(cmd).trim();
        trace.push(`${safe}»${res?.code ?? "?"}`);
        return res;
      },
      (err: Error) => { trace.push(`${String(cmd).trim()}»ERR`); throw err; }
    );
  // EPSV'yi atla: doğrudan PASV (host yukarıda düzeltiliyor).
  ftp.prepareTransfer = enterPassiveModeIPv4;
  if (onProgress) {
    ftp.trackProgress((info) => { if (total > 0) onProgress(Math.min(99, Math.round((info.bytesOverall / total) * 100))); });
  }

  let stage = "connect";
  try {
    await ftp.access({
      host, port: 990, user: "bblp", password: accessCode,
      secure: "implicit",
      // TLS 1.2'ye sabitle → vsftpd'nin zorunlu kıldığı veri-kanalı TLS oturum yeniden kullanımı
      // çalışır. (Node 22 default TLS 1.3'te oturum bileti async geldiği için reuse başarısız olup
      // veri bağlantısı reddediliyordu → "Timeout (control socket)".)
      secureOptions: { rejectUnauthorized: false, minVersion: "TLSv1.2", maxVersion: "TLSv1.2", servername: host },
    });
    // Veri kanalını büyük dosyadan ÖNCE kanıtla (kök listesi).
    stage = "list";
    const before = await ftp.list();
    trace.push(`LIST»${before.length}`);
    stage = "upload";
    await ftp.uploadFrom(Readable.from(fileBuf), remoteName);
    // Yüklemeyi DOĞRULA: önce SIZE, olmazsa LIST'te ada bak.
    stage = "verify";
    let okSize = -1;
    try { okSize = await ftp.size(remoteName); trace.push(`SIZE»${okSize}`); } catch { /* SIZE yok olabilir */ }
    let verified = okSize === total;
    if (!verified) {
      const after = await ftp.list();
      verified = after.some((f) => f.name === remoteName && (f.size === total || f.size <= 0 || total <= 0));
      trace.push(`VERIFY»${verified}`);
    }
    if (!verified) throw new Error("VERIFY_FAILED");
    onProgress?.(100);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Tam teknik döküm SADECE sunucu konsoluna (trace'te PASS*** maskeli → access code asla loglanmaz).
    console.error(`[bambu-ftp] ${host} ${stage} basarisiz: ${raw} · iz: ${trace.join(" ")}`);
    const userMsg = stage === "connect"
      ? "Yazıcıya FTP bağlantısı kurulamadı (TLS / port 990)."
      : raw === "VERIFY_FAILED"
        ? "Yükleme doğrulanamadı — dosya yazıcıya tam ulaşmadı."
        : "Dosya yazıcıya yüklenemedi (veri bağlantısı).";
    throw new Error(`${userMsg} · iz: ${trace.join(" ")}`);
  } finally {
    try { ftp.trackProgress(); } catch { /* tracker'ı durdur */ }
    ftp.close();
  }
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
  opts: { amsMapping?: number[]; useAms?: boolean; onProgress?: (pct: number) => void } = {}
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
  const payload: Record<string, unknown> = isGcode
    ? { print: { sequence_id: "0", command: "gcode_file", param: `/${remoteName}` } }
    : {
        print: {
          sequence_id: "0",
          command: "project_file",
          param: "Metadata/plate_1.gcode",
          project_id: "0", profile_id: "0", task_id: "0", subtask_id: "0",
          subtask_name: stem,
          file: "",
          url: `ftp:///${remoteName}`,
          md5: fileMd5,
          timelapse: false, bed_type: "auto", bed_leveling: true,
          flow_cali: true, vibration_cali: true, layer_inspect: false,
          ams_mapping: opts.amsMapping ?? [0],
          use_ams: opts.useAms ?? false,
        },
      };
  conn.client.publish(`device/${serial}/request`, JSON.stringify(payload), { qos: 1 });
  // A1/P1 seyrek (delta) raporlar → durum geçişini görebilmek için tam durum iste.
  conn.client.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }), { qos: 0 });

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
