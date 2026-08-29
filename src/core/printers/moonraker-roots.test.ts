/**
 * KÖK İZİNLERİ — "bu videoyu silebilir miyiz?" sorusunun tek kaynağı.
 *
 * Yanıtlar GERÇEK cihazlardan alındı (29 Ağu 2026):
 *   Snapmaker U1        → camera kökü salt-okunur ("r"); DELETE 405 dönüyor.
 *   Elegoo N4 Pro/Plus  → `/server/files/roots` ucu hiç yok (eski Moonraker → 404).
 *
 * Bu ayrım önemli: izin bilgisi YOKSA silmeyi kapatmak yanlış olur (eski Moonraker'larda
 * silme çalışıyor), izin "r" ise düğmeyi açık bırakmak yanlış olur (kullanıcı tıklar, hata alır).
 */
import { describe, expect, it } from "vitest";
import { koklerdenIzin } from "./moonraker";

describe("Snapmaker U1 (gerçek yanıt)", () => {
  const u1 = [
    { name: "config", path: "/oem/printer_data/config", permissions: "r" },
    { name: "logs", path: "/userdata/logs", permissions: "r" },
    { name: "gcodes", path: "/userdata/gcodes", permissions: "rw" },
    { name: "camera", path: "/oem/printer_data/camera", permissions: "r" },
  ];

  it("camera kökü salt-okunur okunur", () => {
    expect(koklerdenIzin(u1)?.get("camera")).toBe("r");
  });

  it("yazılabilir kök 'w' içerir", () => {
    expect(koklerdenIzin(u1)?.get("gcodes")).toContain("w");
  });

  it("salt-okunur kök 'w' İÇERMEZ — silme düğmesini kapatan koşul budur", () => {
    expect((koklerdenIzin(u1)?.get("camera") ?? "").includes("w")).toBe(false);
  });
});

describe("izin bilgisi yoksa null (iyimser davran)", () => {
  it("eski Moonraker 404 gövdesi → null", () => {
    // Elegoo'nun gerçek yanıtı: {"error": {...}} — dizi değil.
    expect(koklerdenIzin({ error: { code: 404, message: "Not Found" } })).toBeNull();
  });

  it("boş dizi → null", () => {
    expect(koklerdenIzin([])).toBeNull();
  });

  it("undefined → null", () => {
    expect(koklerdenIzin(undefined)).toBeNull();
  });
});

describe("bozuk kayıtlar", () => {
  it("eksik alanlı kayıtlar atlanır, sağlamlar kalır", () => {
    const m = koklerdenIzin([
      { name: "camera" },                       // permissions yok
      { permissions: "rw" },                    // name yok
      null,
      "camera",
      { name: "timelapse", permissions: "rw" },
    ]);
    expect(m?.size).toBe(1);
    expect(m?.get("timelapse")).toBe("rw");
  });
});
