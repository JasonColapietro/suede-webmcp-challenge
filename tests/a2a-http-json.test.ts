import { describe, expect, it, vi } from "vitest";
import {
  A2A_MEDIA_TYPE,
  A2A_PROTOCOL_VERSION,
  directMessageTaskNotFound,
  handleA2ASendMessage,
  listDirectMessageTasks,
  type PublishedAgentRunHandler,
} from "@/lib/discovery/a2a-http-json";
import { buildSuedeAgentCard } from "@/lib/discovery/agent-card";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";
import { SITE_URL } from "@/lib/site";

const context = {
  params: Promise.resolve({ agent: "po-match-gate-mkgu0" }),
};

function messageRequest(
  body: unknown,
  options: {
    version?: string;
    contentType?: string;
    query?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    "content-type": options.contentType ?? A2A_MEDIA_TYPE,
    ...options.headers,
  });
  if (options.version !== undefined) headers.set("A2A-Version", options.version);
  return new Request(
    `${SITE_URL}/api/agents/po-match-gate-mkgu0/a2a/message:send${options.query ?? ""}`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

const validMessage = {
  message: {
    messageId: "buyer-message-1",
    contextId: "buyer-context-1",
    role: "ROLE_USER",
    parts: [
      {
        data: { poNumber: "PO-100", invoiceNumber: "INV-100" },
        mediaType: "application/json",
      },
    ],
  },
};

const AP2_EXTENSION_URI = "https://github.com/google-agentic-commerce/ap2/v1";
const ap2Enabled = async () => ({ advertise: true });
const ap2Disabled = async () => ({ advertise: false });

async function a2aErrorReason(response: Response): Promise<string | undefined> {
  const body = await response.json() as {
    error?: { details?: Array<{ reason?: string }> };
  };
  return body.error?.details?.[0]?.reason;
}

describe("A2A 1.0 HTTP+JSON adapter", () => {
  it("maps a structured SendMessage through the canonical run handler", async () => {
    const run = vi.fn<PublishedAgentRunHandler>(async () => Response.json({
      runId: "run-1",
      status: "done",
      totalCostUsdc: 0,
      outputs: { output: { decision: "approve" } },
      result: { decision: "approve", confidence: 0.97 },
      settled: false,
      mode: "dry-run",
    }));

    const response = await handleA2ASendMessage(
      messageRequest(validMessage, {
        version: A2A_PROTOCOL_VERSION,
        query: "?dryRun=1&tenant=must-not-leak",
        headers: {
          authorization: "Bearer must-not-leak",
          cookie: "session=must-not-leak",
          "payment-signature": "signed-payment",
        },
      }),
      context,
      run,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(A2A_MEDIA_TYPE);
    expect(response.headers.get("a2a-version")).toBe(A2A_PROTOCOL_VERSION);
    const body = await response.json() as {
      message: {
        messageId: string;
        contextId: string;
        role: string;
        parts: Array<{ data: unknown; mediaType: string }>;
        metadata: { "x-suede": Record<string, unknown> };
      };
    };
    expect(body.message).toMatchObject({
      contextId: "buyer-context-1",
      role: "ROLE_AGENT",
      parts: [{ data: { decision: "approve", confidence: 0.97 }, mediaType: "application/json" }],
      metadata: {
        "x-suede": {
          requestMessageId: "buyer-message-1",
          runId: "run-1",
          settled: false,
          mode: "dry-run",
        },
      },
    });
    expect(body.message.messageId).toBeTruthy();
    expect(run).toHaveBeenCalledOnce();
    const forwarded = run.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(`${SITE_URL}/api/agents/po-match-gate-mkgu0/run?dryRun=1`);
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("cookie")).toBeNull();
    expect(forwarded?.headers.get("payment-signature")).toBe("signed-payment");
    expect(await forwarded?.json()).toEqual({
      input: { poNumber: "PO-100", invoiceNumber: "INV-100" },
    });
  });

  it("ignores an optional AP2 extension while runtime advertisement is off", async () => {
    const run = vi.fn<PublishedAgentRunHandler>(async () => Response.json({
      runId: "run-ap2-off",
      status: "done",
      outputs: { ok: true },
      settled: false,
    }));

    const response = await handleA2ASendMessage(
      messageRequest(validMessage, {
        version: A2A_PROTOCOL_VERSION,
        headers: { "A2A-Extensions": AP2_EXTENSION_URI },
      }),
      context,
      run,
      ap2Disabled,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("a2a-extensions")).toBeNull();
    const forwarded = run.mock.calls[0]?.[0];
    expect(forwarded?.headers.get("a2a-extensions")).toBeNull();
    expect(await forwarded?.json()).toEqual({
      input: { poNumber: "PO-100", invoiceNumber: "INV-100" },
    });
  });

  it.each([
    ["without an activation header", {}],
    ["with an optional activation header", { "A2A-Extensions": AP2_EXTENSION_URI }],
  ])("rejects AP2 mandate data as unavailable while runtime advertisement is off %s", async (_label, headers) => {
    const run = vi.fn<PublishedAgentRunHandler>(async () => Response.json({ status: "must-not-run" }));
    const body = {
      message: {
        ...validMessage.message,
        parts: [
          validMessage.message.parts[0],
          { data: { "ap2.mandates.CheckoutMandateSdJwt": "checkout~" } },
          { data: { "ap2.mandates.PaymentMandateSdJwt": "payment~" } },
        ],
      },
    };

    const response = await handleA2ASendMessage(
      messageRequest(body, {
        version: A2A_PROTOCOL_VERSION,
        headers,
      }),
      context,
      run,
      ap2Disabled,
    );

    expect(response.status).toBe(400);
    expect(await a2aErrorReason(response)).toBe("EXTENSION_NOT_AVAILABLE");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an incomplete mandate pair",
      [
        validMessage.message.parts[0],
        { data: { "ap2.mandates.CheckoutMandateSdJwt": "checkout~" } },
      ],
    ],
    [
      "mandate data mixed into business input",
      [{
        data: {
          poNumber: "PO-100",
          invoiceNumber: "INV-100",
          "ap2.mandates.CheckoutMandateSdJwt": "checkout~",
        },
      }],
    ],
  ])("fails closed with extension-not-available for %s while AP2 is off", async (_label, parts) => {
    const run = vi.fn<PublishedAgentRunHandler>(async () => Response.json({ status: "must-not-run" }));
    const response = await handleA2ASendMessage(
      messageRequest({
        message: { ...validMessage.message, parts },
      }, {
        version: A2A_PROTOCOL_VERSION,
        headers: { "A2A-Extensions": AP2_EXTENSION_URI },
      }),
      context,
      run,
      ap2Disabled,
    );

    expect(response.status).toBe(400);
    expect(await a2aErrorReason(response)).toBe("EXTENSION_NOT_AVAILABLE");
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves the x402 challenge and payment headers for an A2A retry", async () => {
    const challenge = { x402Version: 2, error: "payment required", accepts: [{}] };
    const run = vi.fn<PublishedAgentRunHandler>(async () => Response.json(challenge, {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": "encoded-challenge",
        Link: `<${SITE_URL}/.well-known/x402>; rel="x402-discovery"`,
      },
    }));

    const response = await handleA2ASendMessage(
      messageRequest(validMessage, { version: A2A_PROTOCOL_VERSION }),
      context,
      run,
    );

    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBe("encoded-challenge");
    expect(response.headers.get("a2a-version")).toBe(A2A_PROTOCOL_VERSION);
    expect(await response.json()).toEqual(challenge);
  });

  it("returns the complete resource envelope while ordinary agents keep result-only parts", async () => {
    const envelope = {
      result: [{ name: "Alpha", tier: "paid" }],
      resourceReceipt: {
        resourceProductId: "resource-product-1",
        resourceVersion: "pack-version-1",
        semanticHash: "a".repeat(64),
        freshness: "fresh",
        evidence: [],
        unknowns: [],
        conflicts: [],
        outputSchemaValid: true,
      },
      payment: { priceUsdc: 0.08, state: "settled", receiptId: "receipt-1" },
    };
    const response = await handleA2ASendMessage(
      messageRequest(validMessage, { version: A2A_PROTOCOL_VERSION }),
      context,
      async () => Response.json(envelope),
    );
    const body = await response.json() as {
      message: { parts: Array<{ data: unknown }> };
    };
    expect(body.message.parts[0]?.data).toEqual(envelope);
  });

  it("preserves a durable pending run instead of reporting A2A completion", async () => {
    const pending = {
      error: "ap2_authorization_pending",
      state: "pending_reconciliation",
    };
    const run = vi.fn<PublishedAgentRunHandler>(async () => Response.json(pending, {
      status: 202,
      headers: { "Retry-After": "3" },
    }));

    const response = await handleA2ASendMessage(
      messageRequest(validMessage, { version: A2A_PROTOCOL_VERSION }),
      context,
      run,
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("a2a-version")).toBe(A2A_PROTOCOL_VERSION);
    expect(await response.json()).toEqual(pending);
  });

  it("negotiates AP2 and forwards only bounded mandate data beside business input", async () => {
    const run = vi.fn<PublishedAgentRunHandler>(async () => Response.json({
      runId: "run-ap2",
      status: "done",
      outputs: {},
      settled: true,
      ap2: { checkoutReceipt: "signed-checkout-receipt" },
    }));
    const body = {
      message: {
        ...validMessage.message,
        parts: [
          validMessage.message.parts[0],
          { data: { "ap2.mandates.CheckoutMandateSdJwt": "checkout~" } },
          { data: { "ap2.mandates.PaymentMandateSdJwt": "payment~" } },
        ],
      },
    };
    const response = await handleA2ASendMessage(
      messageRequest(body, {
        version: A2A_PROTOCOL_VERSION,
        headers: {
          "A2A-Extensions": AP2_EXTENSION_URI,
          authorization: "Bearer must-not-leak",
        },
      }),
      context,
      run,
      ap2Enabled,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("a2a-extensions")).toBe(AP2_EXTENSION_URI);
    const forwarded = run.mock.calls[0]?.[0];
    expect(forwarded?.headers.get("a2a-extensions")).toBe(AP2_EXTENSION_URI);
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(await forwarded?.json()).toEqual({
      input: { poNumber: "PO-100", invoiceNumber: "INV-100" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout~",
        paymentMandateSdJwt: "payment~",
      },
    });
    const responseBody = await response.json() as {
      message: { parts: Array<{ data: Record<string, unknown> }> };
    };
    expect(responseBody.message.parts).toContainEqual({
      data: { "ap2.CheckoutReceipt": "signed-checkout-receipt" },
      mediaType: "application/json",
    });
  });

  it("rejects AP2 data without activation but ignores unknown optional extensions", async () => {
    const run = vi.fn<PublishedAgentRunHandler>();
    const body = {
      message: {
        ...validMessage.message,
        parts: [
          validMessage.message.parts[0],
          { data: { "ap2.mandates.CheckoutMandateSdJwt": "checkout~" } },
          { data: { "ap2.mandates.PaymentMandateSdJwt": "payment~" } },
        ],
      },
    };
    const inactive = await handleA2ASendMessage(
      messageRequest(body, { version: A2A_PROTOCOL_VERSION }),
      context,
      run,
      ap2Enabled,
    );
    expect(inactive.status).toBe(400);
    expect(await a2aErrorReason(inactive)).toBe("EXTENSION_NOT_ACTIVATED");

    const optionalRun = vi.fn<PublishedAgentRunHandler>(async () => Response.json({
      runId: "run-optional",
      status: "done",
      outputs: { ok: true },
      settled: false,
    }));
    const optional = await handleA2ASendMessage(
      messageRequest(validMessage, {
        version: A2A_PROTOCOL_VERSION,
        headers: { "A2A-Extensions": "https://example.com/unknown-extension/v1" },
      }),
      context,
      optionalRun,
    );
    expect(optional.status).toBe(200);
    expect(optional.headers.get("a2a-extensions")).toBeNull();
    expect(optionalRun).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects mismatched direct and autonomous AP2 chain shapes before execution", async () => {
    const run = vi.fn<PublishedAgentRunHandler>();
    const response = await handleA2ASendMessage(
      messageRequest({
        message: {
          ...validMessage.message,
          parts: [
            validMessage.message.parts[0],
            { data: { "ap2.mandates.CheckoutMandateSdJwt": "open~~closed~" } },
            { data: { "ap2.mandates.PaymentMandateSdJwt": "closed~" } },
          ],
        },
      }, {
        version: A2A_PROTOCOL_VERSION,
        headers: { "A2A-Extensions": AP2_EXTENSION_URI },
      }),
      context,
      run,
      ap2Enabled,
    );

    expect(response.status).toBe(400);
    expect(await a2aErrorReason(response)).toBe("INVALID_AP2_PRESENTATION");
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves a signed AP2 rejection receipt in A2A error metadata", async () => {
    const run = vi.fn<PublishedAgentRunHandler>(async () => Response.json({
      error: "invalid_mandate",
      message: "AP2 mandate does not authorize this request.",
      ap2: { checkoutReceipt: "signed-error-checkout-receipt" },
    }, { status: 403 }));
    const body = {
      message: {
        ...validMessage.message,
        parts: [
          validMessage.message.parts[0],
          { data: { "ap2.mandates.CheckoutMandateSdJwt": "checkout~" } },
          { data: { "ap2.mandates.PaymentMandateSdJwt": "payment~" } },
        ],
      },
    };

    const response = await handleA2ASendMessage(
      messageRequest(body, {
        version: A2A_PROTOCOL_VERSION,
        headers: { "A2A-Extensions": AP2_EXTENSION_URI },
      }),
      context,
      run,
      ap2Enabled,
    );
    const responseBody = await response.json() as {
      error: { details: Array<{ metadata?: Record<string, string> }> };
    };

    expect(response.status).toBe(403);
    expect(responseBody.error.details[0]?.metadata).toEqual({
      "ap2.CheckoutReceipt": "signed-error-checkout-receipt",
    });
  });

  it("maps run validation and rate-limit details into bounded A2A errors", async () => {
    const invalidRun = vi.fn<PublishedAgentRunHandler>(async () => Response.json({
      error: "invalid_input",
      violations: ["missing required field \"invoiceNumber\""],
    }, { status: 400 }));
    const invalid = await handleA2ASendMessage(
      messageRequest(validMessage, { version: A2A_PROTOCOL_VERSION }),
      context,
      invalidRun,
    );
    const invalidBody = await invalid.json() as {
      error: { details: Array<{ "@type": string; fieldViolations?: unknown[] }> };
    };
    expect(invalid.status).toBe(400);
    expect(invalidBody.error.details[1]).toMatchObject({
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      fieldViolations: [{
        field: "message.parts[0].data",
        description: "missing required field \"invoiceNumber\"",
      }],
    });

    const limitedRun = vi.fn<PublishedAgentRunHandler>(async () => Response.json({
      error: "rate_limited",
      message: "Too many requests.",
    }, { status: 429, headers: { "Retry-After": "2" } }));
    const limited = await handleA2ASendMessage(
      messageRequest(validMessage, { version: A2A_PROTOCOL_VERSION }),
      context,
      limitedRun,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2");
  });

  it("enforces A2A version negotiation before execution", async () => {
    const run = vi.fn<PublishedAgentRunHandler>();
    const missingVersion = await handleA2ASendMessage(
      messageRequest(validMessage),
      context,
      run,
    );
    expect(missingVersion.status).toBe(400);
    expect(await a2aErrorReason(missingVersion)).toBe("VERSION_NOT_SUPPORTED");

    const futureVersion = await handleA2ASendMessage(
      messageRequest(validMessage, { version: "2.0" }),
      context,
      run,
    );
    expect(futureVersion.status).toBe(400);
    expect(await a2aErrorReason(futureVersion)).toBe("VERSION_NOT_SUPPORTED");

    const oversizedVersion = await handleA2ASendMessage(
      messageRequest(validMessage, { version: "2.0".repeat(100) }),
      context,
      run,
    );
    const oversizedBody = await oversizedVersion.text();
    expect(oversizedVersion.status).toBe(400);
    expect(oversizedBody).toContain('"requestedVersion":"invalid"');
    expect(oversizedBody).not.toContain("2.02.0");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects non-structured and ambiguous parts before execution", async () => {
    const run = vi.fn<PublishedAgentRunHandler>();
    const text = await handleA2ASendMessage(
      messageRequest({
        message: {
          messageId: "text-1",
          role: "ROLE_USER",
          parts: [{ text: "approve this invoice" }],
        },
      }, { version: A2A_PROTOCOL_VERSION }),
      context,
      run,
    );
    expect(text.status).toBe(400);
    expect(await a2aErrorReason(text)).toBe("CONTENT_TYPE_NOT_SUPPORTED");

    const ambiguous = await handleA2ASendMessage(
      messageRequest({
        message: {
          messageId: "ambiguous-1",
          role: "ROLE_USER",
          parts: [{ text: "wrong", data: { invoice: "INV-1" } }],
        },
      }, { version: A2A_PROTOCOL_VERSION }),
      context,
      run,
    );
    expect(ambiguous.status).toBe(400);
    expect(await a2aErrorReason(ambiguous)).toBe("INVALID_REQUEST");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects task continuations because this interface returns direct messages", async () => {
    const run = vi.fn<PublishedAgentRunHandler>();
    const response = await handleA2ASendMessage(
      messageRequest({
        message: {
          ...validMessage.message,
          taskId: "task-does-not-exist",
        },
      }, { version: A2A_PROTOCOL_VERSION }),
      context,
      run,
    );
    expect(response.status).toBe(404);
    expect(await a2aErrorReason(response)).toBe("TASK_NOT_FOUND");
    expect(run).not.toHaveBeenCalled();
  });

  it("serves coherent direct-message task operations", async () => {
    const list = listDirectMessageTasks(new Request(
      `${SITE_URL}/api/agents/example/a2a/tasks?pageSize=25`,
      { headers: { "A2A-Version": A2A_PROTOCOL_VERSION } },
    ));
    expect(await list.json()).toEqual({
      tasks: [],
      totalSize: 0,
      pageSize: 25,
      nextPageToken: "",
    });

    const get = directMessageTaskNotFound(new Request(
      `${SITE_URL}/api/agents/example/a2a/tasks/task-1`,
      { headers: { "A2A-Version": A2A_PROTOCOL_VERSION } },
    ), "task-1");
    expect(get.status).toBe(404);
    expect(await a2aErrorReason(get)).toBe("TASK_NOT_FOUND");
  });

  it("advertises the standard binding while retaining x402 in the Suede extension", () => {
    const card = buildSuedeAgentCard({
      name: "PO Match Gate",
      slug: "po-match-gate-mkgu0",
      description: "Match a purchase order to an invoice.",
      priceUsdc: 0.1,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      tags: ["finance"],
      paymentState: "payment-enabled",
      publishedLive: true,
      fulfillmentSupportsAp2: true,
    });
    expect(card.supportedInterfaces).toEqual([{
      url: `${SITE_URL}/api/agents/po-match-gate-mkgu0/a2a`,
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0",
    }]);
    expect(card.capabilities.extensions).toEqual([
      expect.objectContaining({
        uri: `${SITE_URL}/docs/payments#caller-pays`,
        required: false,
        params: expect.objectContaining({ rail: "x402", version: 2 }),
      }),
    ]);
    expect(card["x-suede"]).toMatchObject({
      endpoint: `${SITE_URL}/api/agents/po-match-gate-mkgu0/run`,
      a2aEndpoint: `${SITE_URL}/api/agents/po-match-gate-mkgu0/a2a/message:send`,
      pricing: { rail: "x402" },
    });
  });

  it("registers and mirrors the namespaced resource contract without changing ordinary cards", () => {
    const resourceContract = {
      extensionUri: RESOURCE_CONTRACT_EXTENSION_URI,
      resourceProductId: "resource-product-1",
      resourceVersion: "pack-version-1",
      semanticHash: "a".repeat(64),
    };
    const card = buildSuedeAgentCard({
      name: "Pricing signals",
      slug: "pricing-signals",
      description: "Return an exact pricing record.",
      priceUsdc: 0.08,
      inputSchema: { type: "object" },
      outputSchema: { type: "array" },
      tags: ["resource"],
      paymentState: "payment-enabled",
      publishedLive: true,
      fulfillmentSupportsAp2: true,
      extensions: { [RESOURCE_CONTRACT_EXTENSION_URI]: resourceContract },
    });
    expect(card.capabilities.extensions).toContainEqual({
      uri: RESOURCE_CONTRACT_EXTENSION_URI,
      description: "Suede Resource Product contract for this exact immutable release.",
      required: false,
      params: resourceContract,
    });
    expect(card["x-suede"].extensions).toEqual({
      [RESOURCE_CONTRACT_EXTENSION_URI]: resourceContract,
    });
  });
});
