/**
 * U1 FİLAMENT BOŞALTMA — bilgisayardan.
 *
 * Kilitlenen davranışlar:
 *   • Her kafa TEK komutla boşaltılır (STAGE yok). 9 Kas 2026'da sahada: iki adımlı akışta
 *     kafa "çekmeye hazır" olunca yazıcı ekranı "doing"i kendisi de gönderdi, ikinci komut
 *     "durum uyuşmazlığı" verip akışı durdurdu. Tek adımda o ara durum hiç oluşmuyor.
 *   • Sıra: START → her kafa (sıradaki önceden ısıtılır) → STOP.
 *   • İlerleme kanalın kendi durumundan: ısınırken sıcaklık, "unload_doing"de geri çekme.
 *   • Komut hata döndü ama kafa boşaldıysa (başka istemci aynı adımı da gönderdi) BAŞARI sayılır.
 *   • Gerçek hatada yarım kafa iptal edilir ve STOP YİNE gönderilir (ısıtıcılar açık kalmasın).
 *   • Baskı sürerken hiç komut gönderilmez.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMoonrakerCaps, clearMoonrakerPort, moonrakerFilamentBosalt, type BosaltmaOlayi } from "./moonraker";

let scriptler: string[];
let durum: string;
/** Bu metni içeren komut HTTP hatası döner. */
let dusecek: string | null;
/** Düşen komutta kafa yine de boşalmış olsun mu (başka istemcinin aynı adımı yaptığı durum). */
let dusseDeBosalt: boolean;
let kanallar: Record<number, string>;

beforeEach(() => {
  clearMoonrakerPort();
  clearMoonrakerCaps();
  scriptler = [];
  durum = "standby";
  dusecek = null;
  dusseDeBosalt = false;
  kanallar = { 0: "load_finish", 1: "load_finish", 2: "load_finish", 3: "load_finish" };
  const json = (body: unknown, ok = true) =>
    ({ ok, status: ok ? 200 : 400, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/printer/objects/query") {
      if (u.search.includes("filament_feed")) {
        const kanal = (n: number) => ({ channel_state: kanallar[n], channel_error: "ok" });
        const nesne = /&(extruder\d?)=temperature/.exec(u.search)?.[1] ?? "extruder";
        return json({ result: { status: {
          "filament_feed left": { extruder0: kanal(0), extruder1: kanal(1) },
          "filament_feed right": { extruder2: kanal(2), extruder3: kanal(3) },
          [nesne]: { temperature: 180, target: 250 },
        } } });
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
      const kafa = Number(/EXTRUDER=(\d)/.exec(script)?.[1] ?? -1);
      if (/ACTION=DOING EXTRUDER=/.test(script)) {
        // Yazıcıdaki gibi: önce ısınma, sonra geri çekme — kanal durumu ilerler.
        kanallar[kafa] = "unload_heating";
        await new Promise((r) => setTimeout(r, 1300));
        kanallar[kafa] = "unload_doing";
        await new Promise((r) => setTimeout(r, 1300));
        if (dusecek && script.includes(dusecek)) {
          kanallar[kafa] = dusseDeBosalt ? "unload_finish" : "unload_fail";
          return json({ error: { message: "[feed] fail" } }, false);
        }
        kanallar[kafa] = "unload_finish";
      }
      if (dusecek && script.includes(dusecek)) return json({ error: { message: "[feed] fail" } }, false);
      return json({ result: "ok" });
    }
    return json({ result: {} });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("U1 filament boşaltma", () => {
  it("tek kafa: tek komut, ilerleme (ısınma → geri çekme → bitti) ve sonunda STOP", async () => {
    const olaylar: BosaltmaOlayi[] = [];
    await moonrakerFilamentBosalt("10.0.0.7", 7125, [2], (o) => olaylar.push(o));
    expect(scriptler).toEqual([
      "AUTO_FEEDING_BATCH ACTION=START",
      "AUTO_FEEDING_BATCH ACTION=DOING EXTRUDER=2 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=STOP",
    ]);
    // İki adımlı akışın komutları ASLA gönderilmez (ekranla çakışıyordu).
    expect(scriptler.some((s) => s.includes("STAGE=prepare") || s.includes("STAGE=doing"))).toBe(false);
    expect(olaylar.some((o) => o.asama === "isiniyor" && o.sicaklik === 180 && o.hedef === 250)).toBe(true);
    expect(olaylar.map((o) => o.asama).filter((a) => a !== "isiniyor")).toEqual(["cekiliyor", "bitti"]);
  });

  it("birden çok kafa: sırayla, sıradaki kafa önceden ısıtılır; tekrar eden/geçersiz kafa elenir", async () => {
    await moonrakerFilamentBosalt("10.0.0.7", 7125, [2, 1, 2, 9], () => {});
    expect(scriptler).toEqual([
      "AUTO_FEEDING_BATCH ACTION=START",
      "AUTO_FEEDING_BATCH ACTION=DOING EXTRUDER=1 NEXT_EXTRUDER=2 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=DOING EXTRUDER=2 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=STOP",
    ]);
  });

  it("komut hata döndü ama kafa boşaldıysa başarı sayılır ve sonraki kafaya geçilir", async () => {
    dusecek = "EXTRUDER=1 NEXT_EXTRUDER=2";
    dusseDeBosalt = true;
    const olaylar: BosaltmaOlayi[] = [];
    await moonrakerFilamentBosalt("10.0.0.7", 7125, [1, 2], (o) => olaylar.push(o));
    expect(scriptler).toContain("AUTO_FEEDING_BATCH ACTION=DOING EXTRUDER=2 UNLOAD=1");
    expect(scriptler.some((s) => s.includes("STAGE=cancel"))).toBe(false);
    expect(olaylar.filter((o) => o.asama === "bitti").map((o) => o.kafa)).toEqual([1, 2]);
  });

  it("gerçek hatada yarım kafa iptal edilir, sonraki kafaya geçilmez ve STOP yine gönderilir", async () => {
    dusecek = "EXTRUDER=1 NEXT_EXTRUDER=3";
    await expect(moonrakerFilamentBosalt("10.0.0.7", 7125, [1, 3], () => {})).rejects.toThrow(/boşaltılamadı/);
    expect(scriptler.slice(-2)).toEqual([
      "AUTO_FEEDING_BATCH ACTION=DOING STAGE=cancel EXTRUDER=1 UNLOAD=1",
      "AUTO_FEEDING_BATCH ACTION=STOP",
    ]);
    expect(scriptler.some((s) => s === "AUTO_FEEDING_BATCH ACTION=DOING EXTRUDER=3 UNLOAD=1")).toBe(false);
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
