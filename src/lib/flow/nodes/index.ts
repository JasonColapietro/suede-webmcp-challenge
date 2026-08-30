/** Registered node definitions. Fan-out adds Suede endpoint nodes here. */
import type { CanonicalNodeDef } from "../executor";
import { inputNode } from "./input";
import { outputNode } from "./output";
import { branchNode } from "./branch";
import { llmNode } from "./llm";
import { classifyNode } from "./ai/classify";
import { extractNode } from "./ai/extract";
import { httpNode } from "./http";
import { transformNode } from "./transform";
import { scheduleNode } from "./schedule";
import { webhookNode } from "./webhook";
import { subflowNode } from "./subflow";
import { loopNode } from "./loop";
import { switchNode } from "./logic/switch";
import { aggregateNode } from "./logic/aggregate";
import { apiOperationNode } from "./api-operation";
import { resourceQueryNode } from "./resources/query";
import { styleCoachNode } from "./suede/styleCoach";
import { generateSongNode } from "./suede/generateSong";
import { royaltySplitNode } from "./suede/royaltySplit";
import { registerIpNode } from "./suede/registerIp";
import { lyricsNode } from "./suede/lyrics";
import { analyzeNode } from "./suede/analyze";
import { stemsNode } from "./suede/stems";
import { midiNode } from "./suede/midi";
import { masteringNode } from "./suede/mastering";
import { rightsLookupNode } from "./suede/rightsLookup";
import { chainChatNode } from "./suede/chainChat";
import { promoNode } from "./suede/promo";
import { promoClaimsNode } from "./suede/promoClaims";
import { extractTextNode } from "./docs/extractText";
import { extractDocxNode } from "./docs/extractDocx";
import { knowledgeSearchNode } from "./docs/knowledgeSearch";
import { generateReportPdfNode } from "./docs/generateReportPdf";
import { parseSpreadsheetNode } from "./data/parseSpreadsheet";
import { filterRowsNode } from "./data/filterRows";
import { generateSpreadsheetNode } from "./data/generateSpreadsheet";
import { fetchUrlNode } from "./web/fetchUrl";
import { slackMessageNode } from "./comms/slackMessage";
import { crmWebhookNode } from "./comms/crmWebhook";
import { generateInvoicePdfNode } from "./finance/generateInvoicePdf";
import { githubIssueNode } from "./devops/githubIssue";
import { githubReadNode } from "./devops/githubRead";
import { githubWorkflowDispatchNode } from "./devops/githubWorkflowDispatch";

export const NODE_DEFS: readonly CanonicalNodeDef[] = [
  inputNode,
  outputNode,
  branchNode,
  llmNode,
  classifyNode,
  extractNode,
  httpNode,
  transformNode,
  scheduleNode,
  webhookNode,
  subflowNode,
  loopNode,
  switchNode,
  aggregateNode,
  apiOperationNode,
  resourceQueryNode,
  styleCoachNode,
  generateSongNode,
  lyricsNode,
  analyzeNode,
  stemsNode,
  midiNode,
  masteringNode,
  rightsLookupNode,
  registerIpNode,
  royaltySplitNode,
  chainChatNode,
  promoNode,
  promoClaimsNode,
  extractTextNode,
  extractDocxNode,
  knowledgeSearchNode,
  generateReportPdfNode,
  parseSpreadsheetNode,
  filterRowsNode,
  generateSpreadsheetNode,
  fetchUrlNode,
  slackMessageNode,
  crmWebhookNode,
  generateInvoicePdfNode,
  githubIssueNode,
  githubReadNode,
  githubWorkflowDispatchNode,
];
