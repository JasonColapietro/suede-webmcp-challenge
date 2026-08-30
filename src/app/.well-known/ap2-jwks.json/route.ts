import { NextResponse } from "next/server";

import {
  deriveMerchantJwks,
  loadAp2ReceiptVerificationSigning,
} from "@/lib/rails/ap2";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const signing = await loadAp2ReceiptVerificationSigning();
  if (!signing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    return NextResponse.json(await deriveMerchantJwks(signing), {
      headers: { "cache-control": "public, max-age=300, stale-while-revalidate=3600" },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
