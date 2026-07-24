import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { fetchMoonrakerSlots, fetchMoonrakerSlotDebug } from "@/core/printers/moonraker";
import { getBambuAmsSlots } from "@/core/printers/bambu";
import { getBambuStatusCached, getMoonrakerStatusCached } from "@/core/printers/status-cache";

export const dynamic = "force-dynamic";

type Slot = { slot: number; color: string; type: string; empty: boolean };

/** En az `ensure` slot garanti et (U1 = 4 kafa; okunamayan slot gri/boş görünür). */
function padSlots(read: Slot[], ensure: number): Slot[] {
  const bySlot = new Map(read.map((s) => [s.slot, s]));
  const maxSlot = Math.max(ensure - 1, read.length ? Math.max(...read.map((s) => s.slot)) : -1);
  const out: Slot[] = [];
  for (let i = 0; i <= maxSlot; i++) {
    out.push(bySlot.get(i) ?? { slot: i, color: "#9ca3af", type: "", empty: true });
  }
  return out;
}

/** Son-bilinen slotlar (yazıcı çevrimdışıyken gösterilir). CANLI başarılı okumada yazılır. */
async function readSlotSnapshot(id: string): Promise<Slot[] | null> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: `slotSnapshot:${id}` } });
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? (parsed as Slot[]) : null;
  } catch {
    return null;
  }
}

function writeSlotSnapshot(id: string, slots: Slot[]): void {
  if (!slots.length) return; // boş okumayı snapshot'a yazma (son iyi renkleri koru)
  const value = JSON.stringify(slots);
  void prisma.appSetting
    .upsert({
      where: { key: `slotSnapshot:${id}` },
      create: { key: `slotSnapshot:${id}`, value },
      update: { value },
    })
    .catch(() => {});
}

/** Yazıcının yüklü slotları — HER ZAMAN CANLI okunur (Bambu AMS / Snapmaker CFS).
 *  Elle renk ayarlama kaldırıldı: uygulamada bir kez ayarlanan renk, makinede sonradan yapılan
 *  değişiklikleri kalıcı gölgeliyordu ("güncel renkleri göremiyorum" bug'ının kök nedeni).
 *  Renkler artık tek kaynaktan: makinenin kendisi. ?debug=1 → Moonraker tanılama. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    if (cfg.type === "bambu") {
      if (!cfg.accessCode || !cfg.serial) {
        return NextResponse.json({ type: "bambu", slots: [] });
      }
      // Çevrimdışıysa canlı MQTT beklemesi yapma → son-bilinen renkleri anında göster.
      const st = await getBambuStatusCached(cfg.host, cfg.accessCode, cfg.serial);
      if (!st.online) {
        const snap = await readSlotSnapshot(id);
        return NextResponse.json({ type: "bambu", slots: snap ?? [], fromSnapshot: true });
      }
      const read = await getBambuAmsSlots(cfg.host, cfg.accessCode, cfg.serial);
      writeSlotSnapshot(id, read);
      return NextResponse.json({ type: "bambu", slots: read });
    }

    // Moonraker — Snapmaker U1: 4 kafa, print_task_config'den canlı.
    if (req.nextUrl.searchParams.get("debug") === "1") {
      const debug = await fetchMoonrakerSlotDebug(cfg.host, cfg.port);
      const read = await fetchMoonrakerSlots(cfg.host, cfg.port);
      return NextResponse.json({ type: "moonraker", slots: padSlots(read, 4), debug });
    }
    // Çevrimdışıysa 14sn'lik fallback zincirine hiç girme → son-bilinen slotları anında dön.
    const mst = await getMoonrakerStatusCached(cfg.host, cfg.port);
    if (!mst.online) {
      const snap = await readSlotSnapshot(id);
      return NextResponse.json({ type: "moonraker", slots: padSlots(snap ?? [], 4), fromSnapshot: true });
    }
    const read = await fetchMoonrakerSlots(cfg.host, cfg.port);
    writeSlotSnapshot(id, read);
    return NextResponse.json({ type: "moonraker", slots: padSlots(read, 4) });
  } catch (error) {
    return jsonError(error);
  }
}
