#!/usr/bin/env node
/**
 * rh-auth.js — Robinhood OAuth2 PKCE Authentication Helper
 *
 * Run this to get an access + refresh token for the Robinhood MCP API.
 * Opens a browser to Robinhood's login page, handles the callback,
 * exchanges the code for tokens, and saves them to rh_tokens.json.
 *
 * Usage: node rh-auth.js
 */

import http from "http";
import crypto from "crypto";
import fs from "fs";
import { URL } from "url";

const OAUTH_META_URL = "https://agent.robinhood.com/.well-known/oauth-authorization-server";
const REGISTER_URL = "https://agent.robinhood.com/oauth/trading/register";
const CALLBACK_PORT = 8765;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const TOKEN_FILE = "rh_tokens.json";

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function main() {
  console.log("\n  Robinhood OAuth2 Authentication\n");

  // Step 1: Fetch OAuth metadata
  console.log("  [1/5] Fetching OAuth metadata...");
  const metaRes = await fetch(OAUTH_META_URL);
  if (!metaRes.ok) { console.error("  Failed to fetch OAuth metadata"); process.exit(1); }
  const meta = await metaRes.json();
  console.log(`    Authorization: ${meta.authorization_endpoint}`);
  console.log(`    Token:         ${meta.token_endpoint}`);
  console.log(`    Registration:  ${meta.registration_endpoint}`);

  // Step 2: Dynamic client registration
  console.log("\n  [2/5] Registering OAuth client...");
  const regRes = await fetch(REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "swingtrader-bot",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!regRes.ok) { console.error("  Client registration failed:", await regRes.text()); process.exit(1); }
  const client = await regRes.json();
  console.log(`    Client ID: ${client.client_id}`);

  // Step 3: Generate PKCE verifier + challenge
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));

  // Build authorization URL
  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "internal");

  console.log("\n  [3/5] Open this URL in your browser to sign in:\n");
  console.log(`  ${authUrl.toString()}\n`);

  // Step 4: Start callback server
  console.log(`  [4/5] Waiting for callback on http://localhost:${CALLBACK_PORT}${CALLBACK_PATH} ...`);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const returnedState = url.searchParams.get("state");
      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h2>Authorization failed</h2><p>${error}: ${url.searchParams.get("error_description") || ""}</p>`);
        reject(new Error(`OAuth error: ${error}`));
        server.close();
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>State mismatch — possible CSRF attack</h2>");
        reject(new Error("State mismatch"));
        server.close();
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h2 style="color:#00a843">✓ Authorization received!</h2>
        <p>Exchanging code for tokens... You can close this tab.</p>
      </body></html>`);
      resolve(authCode);
      setTimeout(() => server.close(), 1000);
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`    Listening...\n`);
    });

    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.error(`  Port ${CALLBACK_PORT} is in use. Kill the other process or change CALLBACK_PORT.`);
      }
      reject(e);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for callback (5 minutes)"));
    }, 5 * 60 * 1000);
  });

  console.log(`  Got authorization code: ${code.slice(0, 10)}...`);

  // Step 5: Exchange code for tokens
  console.log("\n  [5/5] Exchanging code for access + refresh tokens...");
  const tokenRes = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error(`  Token exchange failed: HTTP ${tokenRes.status} — ${errText}`);
    process.exit(1);
  }

  const tokens = await tokenRes.json();

  if (!tokens.access_token) {
    console.error("  No access_token in response:", JSON.stringify(tokens).slice(0, 300));
    process.exit(1);
  }

  // Save tokens
  const saved = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresIn: tokens.expires_in || null,
    clientId: client.client_id,
    // Refresh grants must go to the same endpoint (and client_id) that minted the tokens.
    tokenEndpoint: meta.token_endpoint,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(saved, null, 2));

  console.log("\n  ✓ Authentication successful!\n");
  console.log(`    Access token:  ${tokens.access_token.slice(0, 20)}...${tokens.access_token.slice(-8)}`);
  console.log(`    Refresh token: ${tokens.refresh_token ? tokens.refresh_token.slice(0, 12) + "..." : "none"}`);
  console.log(`    Expires in:    ${tokens.expires_in ? tokens.expires_in + "s" : "unknown"}`);
  console.log(`    Saved to:      ${TOKEN_FILE}`);
  console.log(`    Client ID:     ${client.client_id}`);
  console.log("\n  The bot will pick this up automatically on next restart.\n");
  console.log("  To set on Render, add these env vars:");
  console.log(`    ROBINHOOD_ACCESS_TOKEN=${tokens.access_token}`);
  if (tokens.refresh_token) {
    console.log(`    ROBINHOOD_REFRESH_TOKEN=${tokens.refresh_token}`);
  }
  console.log("");
}

main().catch(e => {
  console.error(`\n  Fatal: ${e.message}\n`);
  process.exit(1);
});
