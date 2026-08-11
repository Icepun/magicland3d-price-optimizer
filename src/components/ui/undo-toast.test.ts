import { describe, expect, it } from "vitest";
import { undoCountdown, UNDO_WINDOW_MS } from "./undo-toast";

/**
 * "Geri al" penceresinin geri sayımı. Kullanıcı için doğrudan hissedilir: düğmede yazan
 * saniye ile düğmenin gerçekten çalıştığı süre BİRBİRİNİ TUTMALI — "0 sn" yazarken hâlâ
 * tıklanabilen ya da süre dolmuşken hâlâ "1 sn" diyen bir düğme kullanıcıya yalan söyler.
 */

describe("geri alma geri sayımı", () => {
  it("başlangıçta tam süreyi ve dolu çubuğu gösterir", () => {
    const durum = undoCountdown(0);
    expect(durum.remainingSeconds).toBe(5);
    expect(durum.percent).toBe(100);
    expect(durum.expired).toBe(false);
  });

  it("süre ilerledikçe çubuk daralır", () => {
    expect(undoCountdown(2_500).percent).toBeCloseTo(50, 6);
    expect(undoCountdown(4_000).percent).toBeCloseTo(20, 6);
  });

  it("süre dolmadan asla 0 saniye yazmaz", () => {
    expect(undoCountdown(UNDO_WINDOW_MS - 1).remainingSeconds).toBe(1);
    expect(undoCountdown(UNDO_WINDOW_MS - 1).expired).toBe(false);
  });

  it("süre dolunca hem 0 yazar hem kapanmayı bildirir", () => {
    const durum = undoCountdown(UNDO_WINDOW_MS);
    expect(durum.remainingSeconds).toBe(0);
    expect(durum.percent).toBe(0);
    expect(durum.expired).toBe(true);
  });

  it("süre aşımında değerler eksiye düşmez", () => {
    const durum = undoCountdown(UNDO_WINDOW_MS * 3);
    expect(durum.percent).toBe(0);
    expect(durum.remainingSeconds).toBe(0);
  });

  it("bozuk/negatif geçen süre başlangıç gibi okunur", () => {
    expect(undoCountdown(-500).percent).toBe(100);
    expect(undoCountdown(Number.NaN).remainingSeconds).toBe(5);
  });

  it("özel süre verilebilir (uzun işlemler için)", () => {
    expect(undoCountdown(5_000, 10_000).remainingSeconds).toBe(5);
    expect(undoCountdown(5_000, 10_000).percent).toBeCloseTo(50, 6);
  });
});
