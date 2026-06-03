import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { fetchMoonrakerSlots, fetchMoonrakerSlotDebug } from "@/core/printers/moonraker";
import { getBambuAmsSlots } from "@/core/printers/bambu";

export const dynamic = "force-dynamic";

type Slot = { slot: number; color: string; type: string; empty: boolean };

/** Kullanıcının uygulamada elle ayarladığı slot renkleri (yazıcı başına, AppSetting'te). */
async function getManualSlots(id: string): Promise<Record<number, { color?: string; type?: string }>> {
  const row = await prisma.appSetting.findUnique({ where: { key: `slotColors:${id}` } }).catch(() => null);
  if (!row?.value) return {};
  try {
    const arr = JSON.parse(row.value);
    const map: Record<number, { color?: string; type?: string }> = {};
    if (Array.isArray(arr)) {
      for (const s of arr) {
        if (s && typeof s.slot === "number") map[s.slot] = { color: typeof s.color === "string" ? s.color : undefined, type: typeof s.type === "string" ? s.type : undefined };
      }
    }
    return map;
  } catch {
    return {};
  }
}

/** Yazıcıdan okunan slotlara elle ayarlanmış renkleri bindir; en az `ensure` slot garanti et. */
function mergeSlots(read: Slot[], manual: Record<number, { color?: string; type?: string }>, ensure: number): Slot[] {
  const bySlot = new Map(read.map((s) => [s.slot, s]));
  const indices = [...read.map((s) => s.slot), ...Object.keys(manual).map(Number)];
  const maxSlot = Math.max(ensure - 1, indices.length ? Math.max(...indices) : -1);
  const out: Slot[] = [];
  for (let i = 0; i <= maxSlot; i++) {
    const base = bySlot.get(i) ?? { slot: i, color: "#9ca3af", type: "", empty: true };
    const m = manual[i];
    if (m && m.color) out.push({ slot: i, color: m.color, type: m.type ?? base.type, empty: false });
    else out.push(base);
  }
  return out;
}

/** Yazıcının yüklü renkli slotları (Bambu AMS / Snapmaker) + elle ayarlanan renkler.
 *  ?debug=1 → Moonraker tanılama (yazıcının açığa çıkardığı objeler). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    const manual = await getManualSlots(id);

    if (cfg.type === "bambu") {
      if (!cfg.accessCode || !cfg.serial) {
        return NextResponse.json({ type: "bambu", slots: mergeSlots([], manual, 0) });
      }
      const read = await getBambuAmsSlots(cfg.host, cfg.accessCode, cfg.serial);
      return NextResponse.json({ type: "bambu", slots: mergeSlots(read as Slot[], manual, 0) });
    }

    // Moonraker — Snapmaker U1: 4 kafa. RFID okuması + elle ayarlanan renk.
    if (req.nextUrl.searchParams.get("debug") === "1") {
      const debug = await fetchMoonrakerSlotDebug(cfg.host, cfg.port);
      const read = await fetchMoonrakerSlots(cfg.host, cfg.port);
      return NextResponse.json({ type: "moonraker", slots: mergeSlots(read, manual, 4), debug });
    }
    const read = await fetchMoonrakerSlots(cfg.host, cfg.port);
    return NextResponse.json({ type: "moonraker", slots: mergeSlots(read, manual, 4) });
  } catch (error) {
    return jsonError(error);
  }
}

/** Elle slot rengi/tipi kaydet: body { slots: [{ slot, color, type }] }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { slots?: unknown };
    const slots = Array.isArray(body.slots)
      ? body.slots
          .filter((s): s is { slot: number; color?: string; type?: string } => !!s && typeof (s as { slot?: unknown }).slot === "number")
          .map((s) => ({ slot: s.slot, color: typeof s.color === "string" ? s.color : "", type: typeof s.type === "string" ? s.type : "" }))
      : [];
    await prisma.appSetting.upsert({
      where: { key: `slotColors:${id}` },
      create: { key: `slotColors:${id}`, value: JSON.stringify(slots) },
      update: { value: JSON.stringify(slots) },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
