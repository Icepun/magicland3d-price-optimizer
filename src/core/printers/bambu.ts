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
import { Client as FtpClient } from "basic-ftp";
import { Readable } from "node:stream";

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

/**
 * Bambu'da baskı başlat: dosyayı SD'ye FTP ile yükle (implicit TLS 990) + MQTT ile başlat.
 * .3mf → project_file (plate + ams_mapping); .gcode → gcode_file (ham).
 * NOT: project_file param/url/ams_mapping kombinasyonu firmware'e duyarlı — ilk testte oturtulacak.
 */
export async function bambuUploadAndPrint(
  host: string,
  accessCode: string,
  serial: string,
  fileBuf: Buffer,
  remoteName: string,
  opts: { amsMapping?: number[]; useAms?: boolean } = {}
): Promise<void> {
  const ftp = new FtpClient(20000);
  ftp.ftp.verbose = false;
  try {
    await ftp.access({
      host,
      port: 990,
      user: "bblp",
      password: accessCode,
      secure: "implicit",
      secureOptions: { rejectUnauthorized: false },
    });
    await ftp.uploadFrom(Readable.from(fileBuf), remoteName);
  } finally {
    ftp.close();
  }

  const conn = ensureConn(host, accessCode, serial);
  const isGcode = /\.(gcode|gco|g)$/i.test(remoteName);
  const subtask = remoteName.replace(/\.[^.]+$/, "");
  const payload: Record<string, unknown> = isGcode
    ? { print: { sequence_id: "0", command: "gcode_file", param: `/mnt/sdcard/${remoteName}` } }
    : {
        print: {
          sequence_id: "0",
          command: "project_file",
          param: "Metadata/plate_1.gcode",
          project_id: "0", profile_id: "0", task_id: "0", subtask_id: "0",
          subtask_name: subtask,
          file: "",
          url: `file:///mnt/sdcard/${remoteName}`,
          md5: "",
          timelapse: false, bed_type: "auto", bed_levelling: true,
          flow_cali: false, vibration_cali: true, layer_inspect: false,
          ams_mapping: opts.amsMapping ?? [0],
          use_ams: opts.useAms ?? false,
        },
      };
  conn.client.publish(`device/${serial}/request`, JSON.stringify(payload), { qos: 1 });
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
