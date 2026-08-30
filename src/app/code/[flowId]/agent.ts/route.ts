import { NextResponse } from "next/server";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getCodeViewData } from "@/lib/code-view";
import { API_OPERATION_V1_UNSUPPORTED } from "@/lib/flow/api-operation-contract";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ flowId: string }> },
): Promise<NextResponse> {
  try {
    const { flowId } = await params;
    const ownerId = await resolveOwnerId();
    const data = await getCodeViewData(flowId, ownerId);
    if (data === null) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return new NextResponse(data.source, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="agent.ts"`,
      },
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (typeof error === "object" && error !== null &&
        Reflect.get(error, "code") === API_OPERATION_V1_UNSUPPORTED) {
      return NextResponse.json({ error: API_OPERATION_V1_UNSUPPORTED }, { status: 409 });
    }
    throw error;
  }
}
