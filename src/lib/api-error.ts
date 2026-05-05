import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { TrendyolApiError } from "@/services/trendyol-client";

export function jsonError(error: unknown, status = 500) {
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: error.issues.map((issue) => issue.message).join(", ") },
      { status: 400 }
    );
  }

  if (error instanceof TrendyolApiError) {
    return NextResponse.json(
      { error: error.message, details: error.details },
      { status: error.status >= 400 && error.status < 500 ? error.status : 502 }
    );
  }

  if (
    error instanceof Error &&
    (error.message.includes("Trendyol API bilgileri eksik") ||
      error.message.includes("Trendyol API anahtarlari okunamadi") ||
      error.message.includes("okunamadi"))
  ) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Bilinmeyen hata" },
    { status }
  );
}
