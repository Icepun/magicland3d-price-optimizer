import { beforeEach, describe, expect, it } from "vitest";
import {
  getOrdersCache,
  getOrdersCacheGeneration,
  invalidateOrdersCache,
  setOrdersCache,
} from "./orders-cache";

describe("orders cache generation", () => {
  beforeEach(() => {
    invalidateOrdersCache();
  });

  it("invalidation sonrası eski background hesabının cache'i geri doldurmasını engeller", () => {
    const staleGeneration = getOrdersCacheGeneration();

    invalidateOrdersCache();

    expect(setOrdersCache({ source: "stale" }, staleGeneration)).toBe(false);
    expect(getOrdersCache()).toBeNull();
  });

  it("güncel nesilde tamamlanan hesabı cache'e yazar", () => {
    const currentGeneration = getOrdersCacheGeneration();
    const body = { source: "fresh" };

    expect(setOrdersCache(body, currentGeneration)).toBe(true);
    expect(getOrdersCache()?.body).toBe(body);
  });
});
