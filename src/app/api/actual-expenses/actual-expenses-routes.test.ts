import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-expense-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let createExpense: typeof import("./route").POST;
let listExpenses: typeof import("./route").GET;
let updateExpense: typeof import("./[id]/route").PATCH;
let deleteExpense: typeof import("./[id]/route").DELETE;
let db: typeof import("@/lib/prisma").prisma;

function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/actual-expenses", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as NextRequest;
}

beforeAll(async () => {
  ({ POST: createExpense, GET: listExpenses } = await import("./route"));
  ({ PATCH: updateExpense, DELETE: deleteExpense } = await import("./[id]/route"));
  ({ prisma: db } = await import("@/lib/prisma"));
});
afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("actual expenses routes", () => {
  it("TL API değerini içeride kuruşa çevirip tekrar TL döndürür", async () => {
    const created = await createExpense(
      request("POST", {
        name: "  Kargo poşeti  ",
        category: "  Paketleme ",
        amount: 12.345,
        paidAt: "2026-07-15T09:00:00.000Z",
        note: " ",
      })
    );
    expect(created.status).toBe(201);
    const payload = await created.json();
    expect(payload).toMatchObject({
      name: "Kargo poşeti",
      category: "Paketleme",
      amount: 12.35,
      note: null,
    });
    expect(payload).not.toHaveProperty("amountKurus");
    expect(
      await db.actualExpense.findUniqueOrThrow({ where: { id: payload.id } })
    ).toMatchObject({ amountKurus: 1235 });

    const listed = await listExpenses();
    expect(await listed.json()).toEqual([expect.objectContaining({ id: payload.id, amount: 12.35 })]);

    const updated = await updateExpense(request("PATCH", { amount: 20.005 }), {
      params: Promise.resolve({ id: payload.id }),
    });
    expect(await updated.json()).toEqual(expect.objectContaining({ amount: 20.01 }));

    const removed = await deleteExpense(request("DELETE"), {
      params: Promise.resolve({ id: payload.id }),
    });
    expect(removed.status).toBe(200);
    expect(await db.actualExpense.count()).toBe(0);
  });

  it("geçersiz tutar ve tarihi reddeder", async () => {
    const response = await createExpense(
      request("POST", { name: "Hatalı", amount: 0, paidAt: "tarih-değil" })
    );
    expect(response.status).toBe(400);
  });
});
