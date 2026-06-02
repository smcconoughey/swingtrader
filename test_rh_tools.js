/**
 * Quick script to discover all available tools on the Robinhood MCP server.
 */
import fetch from "node-fetch";

const MCP_ENDPOINT = "https://agent.robinhood.com/mcp/trading";
const TOKEN = (process.env.ROBINHOOD_ACCESS_TOKEN || "").trim();

if (!TOKEN) { console.log("Set ROBINHOOD_ACCESS_TOKEN"); process.exit(1); }

let rpcId = 1;
let sessionId = null;

async function mcpCall(method, params = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${TOKEN}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });

  const newSid = res.headers.get("mcp-session-id");
  if (newSid) sessionId = newSid;

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split("\n");
    let lastData = null;
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try { lastData = JSON.parse(line.slice(6)); } catch {}
      }
    }
    if (lastData?.result) return lastData.result;
    if (lastData?.error) throw new Error(JSON.stringify(lastData.error));
    return lastData;
  }

  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

async function main() {
  console.log("Initializing MCP session...");
  const init = await mcpCall("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "tool-discovery", version: "1.0.0" },
  });
  console.log("Server:", init?.serverInfo?.name, init?.serverInfo?.version);

  // Send initialized notification
  await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  console.log("\nDiscovering available tools...\n");
  const tools = await mcpCall("tools/list", {});
  
  if (tools?.tools) {
    console.log(`Found ${tools.tools.length} tools:\n`);
    for (const t of tools.tools) {
      console.log(`═══ ${t.name} ═══`);
      console.log(`  ${t.description || "(no description)"}`);
      if (t.inputSchema?.properties) {
        const props = t.inputSchema.properties;
        const required = new Set(t.inputSchema.required || []);
        for (const [k, v] of Object.entries(props)) {
          const req = required.has(k) ? " (REQUIRED)" : "";
          console.log(`  - ${k}: ${v.type || "?"}${req} — ${v.description || ""}`);
        }
      }
      console.log();
    }
  } else {
    console.log("Raw response:", JSON.stringify(tools, null, 2));
  }
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
