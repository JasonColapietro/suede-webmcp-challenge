/** Server-only single-node loader for the gateway cold path. */
import type { NodeDef } from "@/lib/flow/executor";
import type { NodeType } from "@/lib/flow/types";

export type GatewayNodeLoader = (nodeType: NodeType) => Promise<NodeDef | undefined>;

export const loadGatewayNode: GatewayNodeLoader = async (nodeType) => {
  switch (nodeType) {
    case "input": return (await import("@/lib/flow/nodes/input")).inputNode;
    case "output": return (await import("@/lib/flow/nodes/output")).outputNode;
    case "schedule": return (await import("@/lib/flow/nodes/schedule")).scheduleNode;
    case "webhook": return (await import("@/lib/flow/nodes/webhook")).webhookNode;
    case "llm": return (await import("@/lib/flow/nodes/llm")).llmNode;
    case "http": return (await import("@/lib/flow/nodes/http")).httpNode;
    case "branch": return (await import("@/lib/flow/nodes/branch")).branchNode;
    case "transform": return (await import("@/lib/flow/nodes/transform")).transformNode;
    case "subflow": return (await import("@/lib/flow/nodes/subflow")).subflowNode;
    case "loop": return (await import("@/lib/flow/nodes/loop")).loopNode;
    case "api.operation": return (await import("@/lib/flow/nodes/api-operation")).apiOperationNode;
    case "resource.query": return (await import("@/lib/flow/nodes/resources/query")).resourceQueryNode;
    case "suede.styleCoach": return (await import("@/lib/flow/nodes/suede/styleCoach")).styleCoachNode;
    case "suede.lyrics": return (await import("@/lib/flow/nodes/suede/lyrics")).lyricsNode;
    case "suede.generateSong": return (await import("@/lib/flow/nodes/suede/generateSong")).generateSongNode;
    case "suede.analyze": return (await import("@/lib/flow/nodes/suede/analyze")).analyzeNode;
    case "suede.stems": return (await import("@/lib/flow/nodes/suede/stems")).stemsNode;
    case "suede.midi": return (await import("@/lib/flow/nodes/suede/midi")).midiNode;
    case "suede.mastering": return (await import("@/lib/flow/nodes/suede/mastering")).masteringNode;
    case "suede.rightsLookup": return (await import("@/lib/flow/nodes/suede/rightsLookup")).rightsLookupNode;
    case "suede.registerIp": return (await import("@/lib/flow/nodes/suede/registerIp")).registerIpNode;
    case "suede.royaltySplit": return (await import("@/lib/flow/nodes/suede/royaltySplit")).royaltySplitNode;
    case "suede.chainChat": return (await import("@/lib/flow/nodes/suede/chainChat")).chainChatNode;
    case "suede.promo": return (await import("@/lib/flow/nodes/suede/promo")).promoNode;
    case "docs.extractText": return (await import("@/lib/flow/nodes/docs/extractText")).extractTextNode;
    case "docs.extractDocx": return (await import("@/lib/flow/nodes/docs/extractDocx")).extractDocxNode;
    case "docs.knowledgeSearch": return (await import("@/lib/flow/nodes/docs/knowledgeSearch")).knowledgeSearchNode;
    case "docs.generateReportPdf": return (await import("@/lib/flow/nodes/docs/generateReportPdf")).generateReportPdfNode;
    case "data.parseSpreadsheet": return (await import("@/lib/flow/nodes/data/parseSpreadsheet")).parseSpreadsheetNode;
    case "data.filterRows": return (await import("@/lib/flow/nodes/data/filterRows")).filterRowsNode;
    case "data.generateSpreadsheet": return (await import("@/lib/flow/nodes/data/generateSpreadsheet")).generateSpreadsheetNode;
    case "comms.slackMessage": return (await import("@/lib/flow/nodes/comms/slackMessage")).slackMessageNode;
    case "comms.crmWebhook": return (await import("@/lib/flow/nodes/comms/crmWebhook")).crmWebhookNode;
    case "devops.githubIssue": return (await import("@/lib/flow/nodes/devops/githubIssue")).githubIssueNode;
    case "devops.githubWorkflowDispatch": return (await import("@/lib/flow/nodes/devops/githubWorkflowDispatch")).githubWorkflowDispatchNode;
    case "finance.generateInvoicePdf": return (await import("@/lib/flow/nodes/finance/generateInvoicePdf")).generateInvoicePdfNode;
  }
};
