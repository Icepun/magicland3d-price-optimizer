/**
 * GERÇEK NOZUL KONUMU — canlı 3B nozulu yazıcının GERÇEK yerinde göstermek için.
 *
 * `gcode_move.gcode_position` okunan son satırın konumu: hareket kuyruğu yüzünden gerçek
 * hareketin ~1-2 sn önünde. `motion_report.live_position` ölçülen konum (23 Eyl 2026: iki U1 de
 * veriyor). Varsa o kullanılır; yoksa eski davranış.
 */
import { describe, expect, it } from "vitest";
import { parseStatus } from "./moonraker";
import { ABONE_NESNELER } from "./moonraker-ws";

describe("Moonraker nozul konumu", () => {
  it("motion_report.live_position varsa gerçek konum", () => {
    const st = parseStatus({
      print_stats: { state: "printing" },
      gcode_move: { gcode_position: [120, 80, 12.4, 3] },
      motion_report: { live_position: [118.5, 79.25, 12.4, 2.9] },
    });
    expect(st.posX).toBeCloseTo(118.5, 6);
    expect(st.posY).toBeCloseTo(79.25, 6);
  });

  it("yoksa komut edilen konuma düşer", () => {
    const st = parseStatus({
      print_stats: { state: "printing" },
      gcode_move: { gcode_position: [120, 80, 12.4, 3] },
    });
    expect(st.posX).toBe(120);
    expect(st.posY).toBe(80);
  });

  it("kalıcı bağlantı da gerçek konuma abone", () => {
    expect(ABONE_NESNELER.motion_report).toEqual(["live_position"]);
  });
});
