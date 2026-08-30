import { initBotId } from "botid/client/core";

initBotId({
  protect: [
    { path: "/api/guided", method: "POST" },
    { path: "/api/site-agent", method: "POST" },
    { path: "/api/site-agent/verify", method: "POST" },
    { path: "/api/companies/found", method: "POST" },
    { path: "/api/moderation/reports", method: "POST" },
  ],
});
