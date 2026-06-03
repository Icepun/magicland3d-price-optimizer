/**
 * Telefon relay'i — masaüstü (LAN'da) tarafında periyodik çalışır:
 *   1) Yerel Turso replica'yı zorla senkronlar (telefonun yazdığı komutları çabuk görür).
 *   2) Her yazıcının canlı durumunu PrinterSnapshot'a yazar (değiştiyse) → telefon okur.
 *   3) Bekleyen PrintCommand'leri LAN'da yazıcıya uygular → sonucu yazar.
 *
 * instrumentation.ts (Next sunucu açılışı) tarafından bir kez başlatılır.
 * Yalnızca Turso modunda anlamlıdır; Turso yoksa snapshot/komut tabloları yine çalışır
 * ama uzaktan erişim olmaz (sorun değil).
 */
import fs from "node:fs";
import { prisma, syncTursoReplica } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  fetchMoonrakerStatus, fetchMoonrakerMeta, moonrakerThumbUrl,
  moonrakerControl, moonrakerUploadAndPrint, type MoonrakerState,
} from "./moonraker";
import { getBambuStatus, bambuControl, mapBambuState } from "./bambu";

const TICK_MS = 10_000;
let started = false;
let ticking = false; // re-entrancy guard — bir tick bitmeden diğeri başlamasın (üst üste binme/birikme yok)
let tickCount = 0; // her 6. tick'te (~60sn) replica pull — sync() sorguları kısa süre bloke ettiği için sıklığı düşük tut (60sn = periyodik takılma yarıya iner; telefon komutları yine ≤60sn'de görülür)
const lastKey = new Map<string, string>();

export function startPrinterRelay() {
  if (started) return;
  started = true;
  setTimeout(() => { void tick(); }, 5000);
  setInterval(() => { void tick(); }, TICK_MS);
}

interface SnapFields {
  name: string; brand: string; status: string; online: boolean;
  productName: string | null; productImage: string | null;
  progress: number; nozzle: number; bed: number;
  currentFilename: string | null; etaSec: number | null;
}

type Cfg = { id: string; name: string; brand: string; model: string | null; type: string; host: string; port: number; accessCode: string | null; serial: string | null };

function moonrakerStatusName(s: MoonrakerState): string {
  switch (s) {
    case "printing": return "printing";
    case "paused": return "paused";
    case "complete": return "finished";
    case "error": return "error";
    default: return "idle";
  }
}

async function buildSnapshot(
  c: Cfg,
  matchMap: Map<string, string>,
  productMap: Map<string, { name: string; imageUrl: string | null }>
): Promise<SnapFields | null> {
  const baseName = c.name;
  if (c.type === "bambu") {
    if (!c.accessCode || !c.serial) {
      return { name: baseName, brand: c.brand, status: "offline", online: false, productName: null, productImage: null, progress: 0, nozzle: 0, bed: 0, currentFilename: null, etaSec: null };
    }
    const bs = await getBambuStatus(c.host, c.accessCode, c.serial);
    if (!bs.online) return { name: baseName, brand: c.brand, status: "offline", online: false, productName: null, productImage: null, progress: 0, nozzle: 0, bed: 0, currentFilename: null, etaSec: null };
    const status = mapBambuState(bs.gcodeState);
    const matchedId = bs.filename ? matchMap.get(`${c.id}::${bs.filename}`) : undefined;
    const matched = matchedId ? productMap.get(matchedId) : undefined;
    return {
      name: baseName, brand: c.brand, status, online: true,
      productName: matched?.name ?? bs.filename ?? null,
      productImage: matched?.imageUrl ?? null,
      progress: Math.min(1, Math.max(0, bs.percent / 100)),
      nozzle: bs.nozzle, bed: bs.bed,
      currentFilename: bs.filename, etaSec: bs.remainingSec,
    };
  }

  // Moonraker
  const st = await fetchMoonrakerStatus(c.host, c.port);
  if (!st.online) return { name: baseName, brand: c.brand, status: "offline", online: false, productName: null, productImage: null, progress: 0, nozzle: 0, bed: 0, currentFilename: null, etaSec: null };
  const status = moonrakerStatusName(st.state);
  let productName: string | null = null;
  let productImage: string | null = null;
  let etaSec: number | null = null;
  if (st.filename && (st.state === "printing" || st.state === "paused" || st.state === "complete")) {
    const matchedId = matchMap.get(`${c.id}::${st.filename}`);
    const matched = matchedId ? productMap.get(matchedId) : undefined;
    productName = matched?.name ?? st.filename;
    if (matched?.imageUrl) productImage = matched.imageUrl;
    else {
      const meta = await fetchMoonrakerMeta(c.host, c.port, st.filename);
      if (meta?.thumbnailRelPath) productImage = moonrakerThumbUrl(c.host, c.port, st.filename, meta.thumbnailRelPath);
    }
    if (st.progress > 0.01 && st.printDurationSec > 0) {
      etaSec = Math.max(0, Math.round(st.printDurationSec / st.progress - st.printDurationSec));
    }
  }
  return {
    name: baseName, brand: c.brand, status, online: true,
    productName, productImage,
    progress: st.progress, nozzle: st.nozzle, bed: st.bed,
    currentFilename: st.filename, etaSec,
  };
}

async function executeCommand(c: Cfg, cmd: { action: string; modelFileId: string | null }): Promise<void> {
  if (cmd.action === "start") {
    if (!cmd.modelFileId) throw new Error("Model dosyası belirtilmedi");
    if (c.type !== "moonraker") throw new Error("Bambu'da uzaktan baskı başlatma henüz desteklenmiyor");
    const mf = await prisma.productModelFile.findUnique({ where: { id: cmd.modelFileId } });
    if (!mf) throw new Error("Model dosyası bulunamadı");
    if (!fs.existsSync(mf.storedPath)) throw new Error("Dosya bu cihazda yok");
    const buf = fs.readFileSync(mf.storedPath);
    await moonrakerUploadAndPrint(c.host, c.port, buf, mf.originalName);
    try {
      await prisma.printFileProduct.upsert({
        where: { printerConfigId_filename: { printerConfigId: c.id, filename: mf.originalName } },
        create: { printerConfigId: c.id, filename: mf.originalName, productId: mf.productId },
        update: { productId: mf.productId },
      });
    } catch { /* eşleştirme kritik değil */ }
    return;
  }
  // pause | resume | cancel
  const action = cmd.action as "pause" | "resume" | "cancel";
  if (c.type === "bambu") {
    if (!c.accessCode || !c.serial) throw new Error("Bambu access code/seri no eksik");
    bambuControl(c.host, c.accessCode, c.serial, action);
  } else {
    await moonrakerControl(c.host, c.port, action);
  }
}

async function tick(): Promise<void> {
  if (ticking) return; // önceki tick hâlâ sürüyorsa atla — yavaş/çevrimdışı yazıcıda tick'ler üst üste binip birikmesin
  ticking = true;
  try {
    await ensureRuntimeSchema();
    // Replica pull'u HER tick'te değil ~60sn'de bir (sync() SQL sorgularını kısa süre bloke
    // ediyor — sıklığı düşürünce blokaj seyrekleşir). Yazmalar (snapshot upsert) zaten anında
    // buluta gider, sync gerektirmez. syncNow ayrıca erişim-kontrollü + guard'lı.
    if (tickCount++ % 6 === 0) await syncTursoReplica().catch(() => {});

    const configs = (await prisma.printerConfig.findMany({ where: { enabled: true } })) as Cfg[];
    if (configs.length === 0) return;

    // Ürün eşleştirmeleri (snapshot'ta ürün adı/görseli için)
    const matches = await prisma.printFileProduct.findMany();
    const matchMap = new Map(matches.map((m) => [`${m.printerConfigId}::${m.filename}`, m.productId]));
    const pids = [...new Set(matches.map((m) => m.productId))];
    const products = pids.length
      ? await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, name: true, imageUrl: true } })
      : [];
    const productMap = new Map(products.map((p) => [p.id, { name: p.name, imageUrl: p.imageUrl }]));

    // 1) Snapshot'lar — PARALEL (çevrimdışı/yavaş yazıcı diğerlerini bekletmesin; toplam süre = en yavaş yazıcı)
    await Promise.all(configs.map(async (c) => {
      let snap: SnapFields | null = null;
      try { snap = await buildSnapshot(c, matchMap, productMap); } catch { snap = null; }
      if (!snap) return;
      const key = [snap.status, snap.online, Math.round(snap.progress * 100), snap.currentFilename, snap.nozzle, snap.bed, snap.productName, snap.etaSec].join("|");
      if (lastKey.get(c.id) === key) return;
      lastKey.set(c.id, key);
      try {
        await prisma.printerSnapshot.upsert({
          where: { printerConfigId: c.id },
          create: { printerConfigId: c.id, ...snap },
          update: snap,
        });
      } catch { /* yazılamadıysa sonraki tick dener */ }
    }));

    // 2) Bekleyen komutlar (sıralı — komut sırası korunmalı)
    let pending: { id: string; printerConfigId: string; action: string; modelFileId: string | null }[] = [];
    try {
      pending = await prisma.printCommand.findMany({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: 10 });
    } catch { return; }

    for (const cmd of pending) {
      try {
        const c = configs.find((x) => x.id === cmd.printerConfigId)
          ?? ((await prisma.printerConfig.findUnique({ where: { id: cmd.printerConfigId } })) as Cfg | null);
        if (!c) throw new Error("Yazıcı bulunamadı");
        await executeCommand(c, cmd);
        await prisma.printCommand.update({ where: { id: cmd.id }, data: { status: "done", processedAt: new Date() } });
      } catch (e) {
        await prisma.printCommand.update({
          where: { id: cmd.id },
          data: { status: "error", error: e instanceof Error ? e.message : "hata", processedAt: new Date() },
        }).catch(() => {});
      }
    }
  } finally {
    ticking = false;
  }
}
