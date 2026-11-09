/**
 * U1 FİLAMENT BOŞALTMA — bilgisayardan, yazıcı ekranının gönderdiği dizinin AYNISI.
 *
 * Kilitlenen davranışlar:
 *   • Sıra: START → (prepare → doing) her kafa → STOP. Birden çok kafada sıradaki kafa
 *     `NEXT_EXTRUDER` ile önceden ısıtılır (ekran da öyle yapıyor).
 *   • Isınma ilerlemesi kafanın gerçek sıcaklığından gelir.
 *   • Bir adım düşerse yarım kalan kafa iptal edilir ve STOP YİNE gönderilir (ısıtıcılar açık kalmasın).
 *   • Baskı sürerken hiç komut gönderilmez.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMoonrakerCaps, clearMoonrakerPort, moonrakerFilamentBosalt, type BosaltmaOlayi } from "./moonraker";

let scriptler: string[];
let durum: string;
let dusecek: string | null;

beforeEach(() => {
  clearMoonrakerPort();
  clearMoonrakerCaps();
  scriptler = [];
  durum = "standby";
  dusecek = null;
  const json = (body: unknown, ok = true) =>
    ({ ok, status: ok ? 200 : 400, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/printer/objects/query") {
      // Yalnız tek kafa sıcaklık okuması (durum sorgusu da extruder alanları içeriyor).
      if (/^\?extruder\d?=temperature,target$/.test(u.search)) {
        const nesne = u.search.slice(1).split("=")[0];
        return json({ result: { status: { [nesne]: { temperature: 180, target: 250 } } } });
      }
      return json({ result: { status: {
        print_stats: { state: durum, filename: null, print_duration: 0, info: {} },
        virtual_sdcard: { progress: 0 },
        extruder: { temperature: 25, target: 0 },
        heater_bed: { temperature: 24, target: 0 },
      } } });
    }
    if (u.pathname === "/printer/gcode/script") {
      const script = typeof init?.body === "string" ? (JSON.parse(init.body) as { script: string }).script : "";
      scriptler.push(script);
      if (dusecek && script.includes(dusecek)) return json({ error: { message: "[feed] fail" } }, false);
      // Isınma adımı kısa bir süre sürsün ki sıcaklık okuması da yapılsın.
      if (script.includes("STAGE=prepare")) await new Promise((r) => setTimeout(r, 1200));
      return json({ result: "ok" });
    }
    return json({ result: {} });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("U1 filament boşaltma", () => {
  it("tek kafa: ekranla aynı sıra, ilerleme olayları ve sonunda STOP", async () => {
    const olaylar: BosaltmaOlayi[] = [];
    await moonrakerFilamentBosalt("10.0.0.7", 7125, [2], (o) => olaylar.push(o));
    expect(scriptler).toEqual([
      "AUTO_FEEDING_BATCH ACTION=START",
      "AUTO_FEEDING_BATCH ACTION=DOING STAGE=prepare EXTRUDER=2 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=DOING STAGE=doing EXTRUDER=2 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=STOP",
    ]);
    expect(olaylar.some((o) => o.asama === "isiniyor" && o.sicaklik === 180 && o.hedef === 250)).toBe(true);
    expect(olaylar.map((o) => o.asama).filter((a) => a !== "isiniyor")).toEqual(["cekiliyor", "bitti"]);
  });

  it("birden çok kafa: sırayla, sıradaki kafa önceden ısıtılır; tekrar eden/geçersiz kafa elenir", async () => {
    await moonrakerFilamentBosalt("10.0.0.7", 7125, [2, 1, 2, 9], () => {});
    expect(scriptler).toEqual([
      "AUTO_FEEDING_BATCH ACTION=START",
      "AUTO_FEEDING_BATCH ACTION=DOING STAGE=prepare EXTRUDER=1 NEXT_EXTRUDER=2 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=DOING STAGE=doing EXTRUDER=1 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=DOING STAGE=prepare EXTRUDER=2 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=DOING STAGE=doing EXTRUDER=2 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=STOP",
    ]);
  });

  it("bir adım düşerse yarım kafa iptal edilir ve STOP yine gönderilir", async () => {
    dusecek = "STAGE=doing EXTRUDER=1";
    await expect(moonrakerFilamentBosalt("10.0.0.7", 7125, [1, 3], () => {})).rejects.toThrow(/boşaltılamadı/);
    expect(scriptler.slice(-2)).toEqual([
      "AUTO_FEEDING_BATCH ACTION=DOING STAGE=cancel EXTRUDER=1 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=STOP",
    ]);
    expect(scriptler.some((s) => s.includes("EXTRUDER=3 UNLOAD=1") && s.includes("STAGE=doing"))).toBe(false);
  });

  it("baskı sürerken hiç komut gönderilmez", async () => {
    durum = "printing";
    // Ayrı adres: durum yazıcı başına birkaç saniye önbellekte tutuluyor (önceki testin "boşta"sı).
    await expect(moonrakerFilamentBosalt("10.0.0.99", 7125, [0], () => {})).rejects.toThrow(/meşgul/);
    expect(scriptler).toEqual([]);
  });

  it("kafa seçilmediyse başlamaz", async () => {
    await expect(moonrakerFilamentBosalt("10.0.0.7", 7125, [], () => {})).rejects.toThrow(/seçilmedi/);
    expect(scriptler).toEqual([]);
  });
});
