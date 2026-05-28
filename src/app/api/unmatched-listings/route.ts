import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

interface UnmatchedRow {
  id: string;
  platform: string;
  externalId: string | null;
  externalSku: string | null;
  barcode: string;
  name: string;
  categoryName: string | null;
  price: number;
  stock: number;
  imageUrl: string | null;
  lastSeenAt: Date | string;
}

/**
 * Henüz bir Shopify ana ürününe bağlanmamış Trendyol/HB listing'lerini döndürür.
 */
export async function GET(req: NextRequest) {
  await ensureRuntimeSchema();
  const { searchParams } = new URL(req.url);
  const platform = searchParams.get("platform");
  const search = searchParams.get("search");

  const filters: string[] = [];
  const params: unknown[] = [];

  if (platform) {
    filters.push("platform = ?");
    params.push(platform);
  }
  if (search) {
    filters.push("(barcode LIKE ? OR externalSku LIKE ? OR name LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `SELECT * FROM UnmatchedListing ${where} ORDER BY lastSeenAt DESC LIMIT 200`;
  const items = await prisma.$queryRawUnsafe<UnmatchedRow[]>(sql, ...params);

  return NextResponse.json(items);
}
