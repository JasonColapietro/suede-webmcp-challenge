import {
  directMessageTaskNotFound,
  unsupportedA2AOperation,
  validateA2AAgent,
} from "@/lib/discovery/a2a-http-json";

export const runtime = "nodejs";

interface TaskOperationContext {
  params: Promise<{ agent: string; operation: string[] }>;
}

function taskIdFromOperation(operation: string[]): string {
  return operation[0]?.replace(/:(cancel|subscribe)$/, "") || "unknown";
}

export async function GET(
  request: Request,
  context: TaskOperationContext,
): Promise<Response> {
  const unavailable = await validateA2AAgent(context);
  if (unavailable) return unavailable;
  const { params } = context;
  const { operation } = await params;
  return directMessageTaskNotFound(request, taskIdFromOperation(operation));
}

export async function POST(
  request: Request,
  context: TaskOperationContext,
): Promise<Response> {
  const unavailable = await validateA2AAgent(context);
  if (unavailable) return unavailable;
  const { params } = context;
  const { operation } = await params;
  const segment = operation[0] ?? "";
  if (segment.endsWith(":subscribe")) {
    return unsupportedA2AOperation(request, "SubscribeToTask");
  }
  return directMessageTaskNotFound(request, taskIdFromOperation(operation));
}

export async function DELETE(
  request: Request,
  context: TaskOperationContext,
): Promise<Response> {
  const unavailable = await validateA2AAgent(context);
  if (unavailable) return unavailable;
  const { params } = context;
  const { operation } = await params;
  return directMessageTaskNotFound(request, taskIdFromOperation(operation));
}
