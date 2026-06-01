import { NextResponse } from "next/server";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";
import { jsonError } from "@/lib/api-error";

export async function POST() {
  try {
    const client = new HepsiburadaClient(await getHepsiburadaCredentials());
    const result = await client.test();
    // Dönen ham örneği de geri ver → UI'da gösterip gerçek alan adlarını teyit edeceğiz.
    return NextResponse.json({ ok: true, sample: result.sample, checkedAt: new Date().toISOString() });
  } catch (error) {
    return jsonError(error);
  }
}
