/**
 * TAKILI FİLAMENTİN RENGİ / TÜRÜ — uygulamadan, yazıcının sabit paletine bağlı kalmadan.
 *
 * U1: yazıcı ekranının gönderdiği komutun AYNISI (gui.log) + etiketli makara koruması + geri okuma.
 * Bambu: `ams_filament_setting` komutu — tür değişmiyorsa makaranın profili/sıcaklıkları korunur,
 * değişiyorsa genel profil; birim numarası rapordan (A2L'nin AMS Lite'ı 16); etiketli makara reddedilir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMoonrakerCaps, clearMoonrakerPort, moonrakerFilamentAyarla } from "./moonraker";
import { bambuFilamentKomutu, bambuKomutReddi } from "./bambu";

/* ── U1 ────────────────────────────────────────────────────────────────────── */

let scriptler: string[];
let ptc: { filament_official: boolean[]; filament_color_rgba: string[]; filament_type: string[] };
let uygula: boolean;
let durum: string;

beforeEach(() => {
  clearMoonrakerPort();
  clearMoonrakerCaps();
  scriptler = [];
  uygula = true;
  durum = "standby";
  ptc = {
    filament_official: [false, false, true, false],
    filament_color_rgba: ["000000FF", "6F4C2FFF", "8C9099FF", "E72F1DFF"],
    filament_type: ["PLA", "PLA", "PLA", "PLA"],
  };
  const json = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/printer/objects/query" && u.search.includes("print_task_config")) {
      return json({ result: { status: { print_task_config: structuredClone(ptc) } } });
    }
    if (u.pathname === "/printer/objects/query") {
      return json({ result: { status: {
        print_stats: { state: durum, filename: null, print_duration: 0, info: {} },
        virtual_sdcard: { progress: 0 }, extruder: { temperature: 25, target: 0 }, heater_bed: { temperature: 24, target: 0 },
      } } });
    }
    if (u.pathname === "/printer/gcode/script") {
      const script = typeof init?.body === "string" ? (JSON.parse(init.body) as { script: string }).script : "";
      scriptler.push(script);
      if (uygula) {
        const kafa = Number(/CONFIG_EXTRUDER=(\d)/.exec(script)?.[1]);
        const renk = /FILAMENT_COLOR_RGBA=([0-9A-F]{8})/.exec(script)?.[1];
        const tip = /FILAMENT_TYPE=(\S+)/.exec(script)?.[1];
        if (renk) ptc.filament_color_rgba[kafa] = renk;
        if (tip) ptc.filament_type[kafa] = tip;
      }
      return json({ result: "ok" });
    }
    return json({ result: {} });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("U1 filament rengi / türü", () => {
  it("ekranın komutunun aynısı: önce tür, sonra renk; paletin dışındaki renk de gider", async () => {
    await moonrakerFilamentAyarla("10.0.0.5", 7125, 1, { renk: "#12ab9c", tip: "PETG" });
    expect(scriptler).toEqual([
      "SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=1 VENDOR=Generic FILAMENT_TYPE=PETG FILAMENT_SUBTYPE=''",
      "SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=1 FILAMENT_COLOR_RGBA=12AB9CFF",
    ]);
  });

  it("zaten aynı olan değer gönderilmez (her kayıt kafanın akış katsayısını sıfırlıyor)", async () => {
    await moonrakerFilamentAyarla("10.0.0.5", 7125, 3, { renk: "#E72F1D", tip: "PETG" });
    expect(scriptler).toEqual(["SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=3 VENDOR=Generic FILAMENT_TYPE=PETG FILAMENT_SUBTYPE=''"]);
  });

  it("Snapmaker'ın etiketli makarası değiştirilmez, komut gitmez", async () => {
    await expect(moonrakerFilamentAyarla("10.0.0.5", 7125, 2, { renk: "#FFFFFF" })).rejects.toThrow(/etiketinden/);
    expect(scriptler).toEqual([]);
  });

  it("yazıcı kaydetmediyse başarı denmez", async () => {
    uygula = false;
    await expect(moonrakerFilamentAyarla("10.0.0.5", 7125, 0, { renk: "#FFFFFF" })).rejects.toThrow(/kaydedilemedi/);
  });

  it("geçersiz tür/renk ve baskı sürerken reddedilir", async () => {
    await expect(moonrakerFilamentAyarla("10.0.0.5", 7125, 0, { tip: "Ahşap" })).rejects.toThrow(/seçilemiyor/);
    await expect(moonrakerFilamentAyarla("10.0.0.5", 7125, 0, { renk: "kırmızı" })).rejects.toThrow(/tanınmadı/);
    durum = "printing";
    await expect(moonrakerFilamentAyarla("10.0.0.66", 7125, 0, { renk: "#FFFFFF" })).rejects.toThrow(/meşgul/);
    expect(scriptler).toEqual([]);
  });
});

/* ── Bambu ─────────────────────────────────────────────────────────────────── */

const tray = (id: number, o: Record<string, unknown> = {}) => ({
  id: String(id), tray_type: "PLA", tray_color: "F5F5F5FF", tray_info_idx: "GFA00",
  nozzle_temp_min: "200", nozzle_temp_max: "220", tag_uid: "0000000000000000", ...o,
});

describe("Bambu AMS makarası rengi / türü", () => {
  it("yalnız renk: makaranın profili ve sıcaklıkları korunur", () => {
    const print = { ams: { ams: [{ id: "0", tray: [tray(0), tray(1), tray(2), tray(3)] }] } };
    const { komut, yeniRenk, yeniTip } = bambuFilamentKomutu(print, 2, { renk: "12AB9C", tip: null });
    expect(yeniRenk).toBe("12AB9C");
    expect(yeniTip).toBe("PLA");
    expect(komut.print).toMatchObject({
      command: "ams_filament_setting", ams_id: 0, tray_id: 2, tray_info_idx: "GFA00",
      tray_color: "12AB9CFF", nozzle_temp_min: 200, nozzle_temp_max: 220, tray_type: "PLA",
    });
  });

  it("tür değişince genel profil ve o türün sıcaklıkları", () => {
    const print = { ams: { ams: [{ id: "0", tray: [tray(0)] }] } };
    const { komut } = bambuFilamentKomutu(print, 0, { renk: null, tip: "PETG" });
    expect(komut.print).toMatchObject({ tray_info_idx: "GFG99", nozzle_temp_min: 220, nozzle_temp_max: 260, tray_type: "PETG", tray_color: "F5F5F5FF" });
  });

  it("A2L'nin AMS Lite'ı: birim numarası rapordan (16)", () => {
    const print = { ams: { ams: [{ id: "16", tray: [tray(0), tray(1), tray(2), tray(3)] }] } };
    expect(bambuFilamentKomutu(print, 3, { renk: "000000", tip: null }).komut.print).toMatchObject({ ams_id: 16, tray_id: 3 });
  });

  it("iki AMS: makara numarası birim sırası × 4 + makara", () => {
    const print = { ams: { ams: [{ id: "0", tray: [tray(0), tray(1), tray(2), tray(3)] }, { id: "1", tray: [tray(0), tray(1), tray(2), tray(3)] }] } };
    expect(bambuFilamentKomutu(print, 5, { renk: "000000", tip: null }).komut.print).toMatchObject({ ams_id: 1, tray_id: 1 });
  });

  it("Bambu'nun etiketli makarası ve olmayan makara reddedilir", () => {
    const print = { ams: { ams: [{ id: "0", tray: [tray(0, { tag_uid: "A1B2C3D4E5F60708" })] }] } };
    expect(() => bambuFilamentKomutu(print, 0, { renk: "000000", tip: null })).toThrow(/etiketinden/);
    expect(() => bambuFilamentKomutu(print, 7, { renk: "000000", tip: null })).toThrow(/bulunamadı/);
  });
  it("yazıcının ret yanıtı kodundan açıklanır (sahada görülen 0x05024001 dahil)", () => {
    // 10 Kas 2026, A2L + A1: {"result":"fail","err_code":84033537,"reason":"error string"}
    expect(bambuKomutReddi({ command: "ams_filament_setting", result: "fail", err_code: 84033537, reason: "error string" }, "26A1XXXX"))
      .toMatch(/baskı işinde/);
    expect(bambuKomutReddi({ result: "fail" })).toBe("Yazıcı bu ayarı kabul etmedi.");
    expect(bambuKomutReddi({ result: "fail", err_code: 0x0bad0001 })).toMatch(/kod 0BAD0001/);
    expect(bambuKomutReddi({ result: "success" })).toBeNull();
    expect(bambuKomutReddi(null)).toBeNull();
  });
});
