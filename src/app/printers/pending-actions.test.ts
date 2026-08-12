/**
 * EŞZAMANLI KOMUTLAR BİRBİRİNİN KİLİDİNİ AÇMAMALI.
 *
 * Sahada ölçülen senaryo: Neptune 4 Pro'da "Duraklat"a basılır (sunucu 12–30sn doğrulama yapar),
 * kullanıcı beklerken Snapmaker U1'in ışık düğmesine basar. Komut durumu tek bir mutation
 * gözlemcisinden türetildiği için Neptune'ün kilidi düşüyor, "Duraklatılıyor…" rozeti kayboluyor
 * ve düğme "Devam et"e dönüyordu — iki tıkla GERÇEKTEN BASAN bir yazıcı duraklatılıp saniyeler
 * içinde yeniden başlatılabiliyordu.
 */
import { describe, expect, it } from "vitest";
import { NO_PENDING, addPending, anyPending, pendingFor, removePending } from "./pending-actions";

type Kind = "pause" | "resume" | "cancel" | "light" | "speed";

describe("komut kilidi yazıcı başına tutulur", () => {
  it("başka yazıcıya gönderilen komut, duraklatılmakta olan yazıcının kilidini AÇMAZ", () => {
    let m = addPending<Kind>(NO_PENDING, "neptune", "pause");
    m = addPending(m, "u1", "light");
    // Işık komutu bitti — Neptune'ün duraklatması hâlâ yolda.
    m = removePending(m, "u1", "light");

    expect(pendingFor(m, "neptune")).toBe("pause");
    expect(pendingFor(m, "u1")).toBeNull();
    expect(anyPending(m)).toBe(true);
  });

  it("aynı yazıcıya iki komut gittiyse ilki bitince kilit açılmaz", () => {
    let m = addPending<Kind>(NO_PENDING, "u1", "speed");
    m = addPending(m, "u1", "light");
    m = removePending(m, "u1", "speed");
    expect(pendingFor(m, "u1")).toBe("light");
    m = removePending(m, "u1", "light");
    expect(pendingFor(m, "u1")).toBeNull();
    expect(anyPending(m)).toBe(false);
  });

  it("kartta EN SON gönderilen komut gösterilir", () => {
    let m = addPending<Kind>(NO_PENDING, "u1", "pause");
    m = addPending(m, "u1", "cancel");
    expect(pendingFor(m, "u1")).toBe("cancel");
  });

  it("olmayan kaydı silmek haritayı bozmaz", () => {
    const m = addPending<Kind>(NO_PENDING, "a", "pause");
    expect(removePending(m, "a", "cancel")).toBe(m);
    expect(removePending(m, "yok", "pause")).toBe(m);
    expect(anyPending(NO_PENDING)).toBe(false);
    expect(pendingFor(NO_PENDING, "a")).toBeNull();
  });

  it("kaynak harita değiştirilmez (React durumu güvenle karşılaştırılır)", () => {
    const base = addPending<Kind>(NO_PENDING, "a", "pause");
    const next = addPending(base, "b", "light");
    expect(base).toEqual({ a: ["pause"] });
    expect(next).not.toBe(base);
  });
});
