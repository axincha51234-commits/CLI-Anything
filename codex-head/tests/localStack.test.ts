import test from "node:test";
import assert from "node:assert/strict";

import { inspectLocalReviewStack } from "../src/localStack";

test("inspectLocalReviewStack reports a ready 9router + Antigravity path", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok", version: "4.1.21" }), { status: 200 });
    }
    if (url.endsWith("/api/proxy/status")) {
      return new Response(JSON.stringify({ running: true, active_accounts: 7 }), { status: 200 });
    }
    if (url.endsWith("/api/version")) {
      return new Response(JSON.stringify({ currentVersion: "0.3.60" }), { status: 200 });
    }
    if (url.endsWith("/api/provider-nodes")) {
      return new Response(JSON.stringify({
        nodes: [
          {
            id: "node-agm",
            prefix: "agm",
            apiType: "chat",
            baseUrl: "http://127.0.0.1:8045/v1"
          },
          {
            id: "node-agr",
            prefix: "agr",
            apiType: "responses",
            baseUrl: "http://127.0.0.1:8045/v1"
          }
        ]
      }), { status: 200 });
    }
    if (url.endsWith("/api/providers")) {
      return new Response(JSON.stringify({
        connections: [
          {
            provider: "node-agm",
            isActive: true,
            defaultModel: "agm/gpt-4o-mini",
            providerSpecificData: {
              prefix: "agm",
              apiType: "chat",
              baseUrl: "http://127.0.0.1:8045/v1"
            }
          },
          {
            provider: "node-agr",
            isActive: true,
            defaultModel: "agr/gpt-4o-mini",
            providerSpecificData: {
              prefix: "agr",
              apiType: "responses",
              baseUrl: "http://127.0.0.1:8045/v1"
            }
          }
        ]
      }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const snapshot = await inspectLocalReviewStack("C:/repo/codex-head", {
    fetch_impl: fetchImpl,
    gui_config_path: "C:/Users/test/.antigravity_tools/gui_config.json",
    exists_sync: (path) => path.endsWith("ensure-9router-antigravity-stack.ps1") || path.endsWith("gui_config.json"),
    read_file_sync: () => JSON.stringify({
      proxy: {
        port: 8045,
        auto_start: true,
        auth_mode: "all_except_health",
        api_key: "secret"
      },
      auto_launch: false
    })
  });

  assert.equal(snapshot.recommended_review_path_ready, true);
  assert.equal(snapshot.antigravity.reachable, true);
  assert.equal(snapshot.antigravity.active_accounts, 7);
  assert.equal(snapshot.router9.reachable, true);
  assert.equal(snapshot.router9.agm_chat.present, true);
  assert.equal(snapshot.router9.agm_chat.active_connection, true);
  assert.equal(snapshot.router9.agr_responses.present, true);
  assert.equal(snapshot.router9.responses_route_suitable_for_codex_cli_local, false);
  assert.match(snapshot.helper_bootstrap_command ?? "", /ensure-9router-antigravity-stack\.ps1/i);
});

test("inspectLocalReviewStack tolerates an offline stack", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };

  const snapshot = await inspectLocalReviewStack("C:/repo/codex-head", {
    fetch_impl: fetchImpl,
    gui_config_path: "C:/missing/gui_config.json",
    exists_sync: () => false,
    read_file_sync: () => ""
  });

  assert.equal(snapshot.detected, false);
  assert.equal(snapshot.recommended_review_path_ready, false);
  assert.equal(snapshot.antigravity.reachable, false);
  assert.equal(snapshot.router9.reachable, false);
  assert.equal(snapshot.router9.agm_chat.present, false);
  assert.equal(snapshot.helper_script_available, false);
});
