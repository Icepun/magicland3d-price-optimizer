/// <reference lib="webworker" />
/**
 * GCode parse Web Worker'ı — dosyayı indirir (.3mf ise plaka gcode'unu çıkarır) ve
 * parseGcode ile geometriye çevirir. AĞIR İŞ TAMAMEN BURADA: arayüz hiç donmaz.
 * Mesaj: { fileId } → { ok, positions, features, layerRanges, bounds, totalSegments } (transfer'li)
 */
import { unzipSync } from "fflate";
import { parseGcode } from "./parse-gcode";

self.onmessage = async (ev: MessageEvent<{ fileId: string }>) => {
  const { fileId } = ev.data;
  try {
    const res = await fetch(`/api/models/${fileId}/file`, { cache: "no-store" });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error((j as { error?: string } | null)?.error || `Dosya alınamadı (HTTP ${res.status})`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 400 * 1024 * 1024) throw new Error("Dosya görselleştirme için çok büyük");

    let text: string;
    // ZIP imzası (PK) → .3mf: plaka gcode'unu çıkar (en büyük Metadata/plate_*.gcode).
    if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const entries = unzipSync(bytes, { filter: (f) => /^Metadata\/plate_\d+\.gcode$/i.test(f.name) });
      const names = Object.keys(entries);
      if (!names.length) throw new Error("3MF içinde plaka gcode'u yok (dilimlenmiş .3mf olmalı)");
      names.sort((a, b) => entries[b].length - entries[a].length);
      text = new TextDecoder().decode(entries[names[0]]);
    } else {
      text = new TextDecoder().decode(bytes);
    }

    const g = parseGcode(text);
    (self as unknown as Worker).postMessage(
      {
        ok: true,
        positions: g.positions.buffer,
        features: g.features.buffer,
        layerRanges: g.layerRanges,
        bounds: g.bounds,
        totalSegments: g.totalSegments,
      },
      [g.positions.buffer, g.features.buffer]
    );
  } catch (e) {
    (self as unknown as Worker).postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
