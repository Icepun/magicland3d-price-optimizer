/**
 * İşletim sistemi bildirimi kararı — hangi bildirim ekrana patlar, hangisi özete düşer.
 *
 * Önemli davranış: yaş sınırına takılan bildirimler SESSİZCE yutulmaz. Eskiden takılanlar
 * "bildirildi" işaretlenip bir daha hiç görünmüyordu (gece biten baskı sabah kayboluyordu).
 */
import { describe, expect, it } from "vitest";
import { OS_AGE_LIMITS, planOsToasts } from "./NotificationBell";

const SIMDI = new Date("2026-08-11T09:00:00.000Z").getTime();

const uyari = (over: Partial<Parameters<typeof planOsToasts>[0][number]> & { id: string }) => ({
  type: "order" as const,
  severity: "critical" as const,
  title: "Stoğu biten ürüne sipariş!",
  body: "Ejderha — Trendyol #1001",
  href: "/products/p1",
  ...over,
});

describe("planOsToasts", () => {
  it("taze bildirimleri tek tek gösterir", () => {
    const plan = planOsToasts(
      [uyari({ id: "a", createdAt: new Date(SIMDI - 60_000).toISOString() })],
      new Set(),
      SIMDI
    );

    expect(plan.toasts).toHaveLength(1);
    expect(plan.toasts[0].body).toBe("Ejderha — Trendyol #1001");
    expect(plan.markNotified).toEqual(["a"]);
  });

  it("uyarı seviyesindekiler için bildirim atmaz", () => {
    const plan = planOsToasts([uyari({ id: "a", severity: "warning" })], new Set(), SIMDI);

    expect(plan.toasts).toEqual([]);
    expect(plan.markNotified).toEqual([]);
  });

  it("daha önce bildirilmişleri tekrar göstermez", () => {
    const plan = planOsToasts([uyari({ id: "a" })], new Set(["a"]), SIMDI);

    expect(plan.toasts).toEqual([]);
    expect(plan.markNotified).toEqual([]);
  });

  it("dörtten fazla yeni bildirimi tek özete indirir", () => {
    const plan = planOsToasts(
      ["a", "b", "c", "d", "e"].map((id) => uyari({ id })),
      new Set(),
      SIMDI
    );

    expect(plan.toasts).toHaveLength(1);
    expect(plan.toasts[0].body).toBe("5 yeni bildirim — zile göz at");
    expect(plan.markNotified).toHaveLength(5);
  });

  it("yaş sınırını aşan bildirimleri yutmaz, tek özetle haber verir", () => {
    const eski = new Date(SIMDI - (OS_AGE_LIMITS.critical + 60_000)).toISOString();
    const plan = planOsToasts([uyari({ id: "a", createdAt: eski })], new Set(), SIMDI);

    expect(plan.toasts).toHaveLength(1);
    expect(plan.toasts[0].body).toBe("1 bildirim seni bekliyor — zile göz at");
    expect(plan.markNotified).toEqual(["a"]);
  });

  it("gece biten baskıyı sabah hâlâ gösterir (başarı bildirimi 24 saat geçerli)", () => {
    const geceYarisi = new Date(SIMDI - 10 * 60 * 60_000).toISOString();
    const plan = planOsToasts(
      [
        uyari({
          id: "printer-done:1",
          severity: "success",
          title: "Baskı tamamlandı 🎉",
          body: "Neptune 4 Pro — Ejderha",
          createdAt: geceYarisi,
        }),
      ],
      new Set(),
      SIMDI
    );

    expect(plan.toasts).toHaveLength(1);
    expect(plan.toasts[0].body).toBe("Neptune 4 Pro — Ejderha");
  });

  it("zamanı olmayan anlık uyarıları taze sayar", () => {
    const plan = planOsToasts([uyari({ id: "stock-p1", createdAt: undefined })], new Set(), SIMDI);

    expect(plan.toasts).toHaveLength(1);
  });
});
