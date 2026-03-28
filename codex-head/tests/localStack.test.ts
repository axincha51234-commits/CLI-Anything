import test from "node:test";
import assert from "node:assert/strict";

import { inspectLocalReviewStack } from "../src/localStack";

test("inspectLocalReviewStack reports a ready 9router + Antigravity path", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith(":20129/health")) {
      return new Response(JSON.stringify({
        status: "ok",
        model_aliases: ["pplxapp/app-chat"],
        runtime_target_available: true
      }), { status: 200 });
    }
    if (url.endsWith(":9233/json/version")) {
      return new Response(JSON.stringify({
        Browser: "Perplexity/1.0"
      }), { status: 200 });
    }
    if (url.endsWith(":8083/health")) {
      return new Response(JSON.stringify({
        status: "ok",
        model_aliases: ["bbxapp/app-agent"],
        state_db_path: "C:/Users/test/AppData/Roaming/BLACKBOXAI/User/globalStorage/state.vscdb",
        state_db_exists: true,
        identity_loaded: true,
        user_id: "user-123",
        upstream_base_url: "https://oi-vscode-server-985058387028.europe-west1.run.app"
      }), { status: 200 });
    }
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
    exists_sync: (path) =>
      path.endsWith("ensure-9router-antigravity-stack.ps1") ||
      path.endsWith("ensure-9router-full-stack.ps1") ||
      path.endsWith("gui_config.json"),
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
  assert.equal(snapshot.perplexity?.manager_reachable, true);
  assert.equal(snapshot.perplexity?.pplxapp_chat.present, false);
  assert.equal(snapshot.blackbox?.manager_reachable, true);
  assert.equal(snapshot.blackbox?.bbxapp_chat.present, false);
  assert.equal(snapshot.blackbox?.identity_loaded, true);
  assert.equal(snapshot.blackbox?.user_id_present, true);
  assert.match(snapshot.helper_bootstrap_command ?? "", /ensure-9router-antigravity-stack\.ps1/i);
  assert.match(snapshot.full_stack_bootstrap_command ?? "", /ensure-9router-full-stack\.ps1/i);
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
  assert.equal(snapshot.full_stack_helper_script_available, false);
});

test("inspectLocalReviewStack honors explicit Perplexity and BLACKBOX manager ports", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "http://host.docker.internal:30129/health") {
      return new Response(JSON.stringify({
        status: "ok",
        model_aliases: ["pplxapp/app-chat"],
        runtime_target_available: true
      }), { status: 200 });
    }
    if (url === "http://host.docker.internal:39233/json/version") {
      return new Response(JSON.stringify({
        Browser: "Perplexity/2.0"
      }), { status: 200 });
    }
    if (url === "http://host.docker.internal:38083/health") {
      return new Response(JSON.stringify({
        status: "ok",
        model_aliases: ["bbxapp/app-agent"],
        state_db_path: "C:/Users/test/AppData/Roaming/BLACKBOXAI/User/globalStorage/state.vscdb",
        state_db_exists: true,
        identity_loaded: true,
        user_id: "user-override",
        upstream_base_url: "https://bbx.example/v1"
      }), { status: 200 });
    }
    if (url === "http://host.docker.internal:8045/health") {
      return new Response(JSON.stringify({ status: "ok", version: "4.1.30" }), { status: 200 });
    }
    if (url === "http://host.docker.internal:8045/api/proxy/status") {
      return new Response(JSON.stringify({ running: true, active_accounts: 7 }), { status: 200 });
    }
    if (url === "http://host.docker.internal:20128/api/version") {
      return new Response(JSON.stringify({ currentVersion: "0.3.60" }), { status: 200 });
    }
    if (url === "http://host.docker.internal:20128/api/provider-nodes") {
      return new Response(JSON.stringify({
        nodes: [
          {
            id: "node-agm",
            prefix: "agm",
            apiType: "chat",
            baseUrl: "http://host.docker.internal:8045/v1"
          },
          {
            id: "node-pplx",
            prefix: "pplxapp",
            apiType: "chat",
            baseUrl: "http://host.docker.internal:30129/v1"
          },
          {
            id: "node-bbx",
            prefix: "bbxapp",
            apiType: "chat",
            baseUrl: "http://host.docker.internal:38083/v1"
          }
        ]
      }), { status: 200 });
    }
    if (url === "http://host.docker.internal:20128/api/providers") {
      return new Response(JSON.stringify({
        connections: [
          {
            provider: "node-agm",
            isActive: true,
            defaultModel: "agm/gpt-4o-mini",
            providerSpecificData: {
              prefix: "agm",
              apiType: "chat",
              baseUrl: "http://host.docker.internal:8045/v1"
            }
          },
          {
            provider: "node-pplx",
            isActive: true,
            defaultModel: "pplxapp/app-chat",
            providerSpecificData: {
              prefix: "pplxapp",
              apiType: "chat",
              baseUrl: "http://host.docker.internal:30129/v1"
            }
          },
          {
            provider: "node-bbx",
            isActive: true,
            defaultModel: "bbxapp/app-agent",
            providerSpecificData: {
              prefix: "bbxapp",
              apiType: "chat",
              baseUrl: "http://host.docker.internal:38083/v1"
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
    antigravity_host: "host.docker.internal",
    router_host: "host.docker.internal",
    perplexity_manager_host: "host.docker.internal",
    perplexity_manager_port: 30129,
    perplexity_cdp_host: "host.docker.internal",
    perplexity_cdp_port: 39233,
    blackbox_manager_host: "host.docker.internal",
    blackbox_manager_port: 38083,
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

  assert.equal(snapshot.antigravity.base_url, "http://host.docker.internal:8045");
  assert.equal(snapshot.router9.base_url, "http://host.docker.internal:20128");
  assert.equal(snapshot.perplexity?.manager_base_url, "http://host.docker.internal:30129");
  assert.equal(snapshot.perplexity?.cdp_base_url, "http://host.docker.internal:39233");
  assert.equal(snapshot.perplexity?.pplxapp_chat.upstream_base_url, "http://host.docker.internal:30129/v1");
  assert.equal(snapshot.blackbox?.manager_base_url, "http://host.docker.internal:38083");
  assert.equal(snapshot.blackbox?.bbxapp_chat.upstream_base_url, "http://host.docker.internal:38083/v1");
});

test("inspectLocalReviewStack honors CODEX_HEAD_LOCALSTACK_HOST when explicit hosts are not provided", async () => {
  const previousDefaultHost = process.env.CODEX_HEAD_LOCALSTACK_HOST;
  process.env.CODEX_HEAD_LOCALSTACK_HOST = "host.docker.internal";

  try {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "http://host.docker.internal:8045/health") {
        return new Response(JSON.stringify({ status: "ok", version: "4.1.31" }), { status: 200 });
      }
      if (url === "http://host.docker.internal:8045/api/proxy/status") {
        return new Response(JSON.stringify({ running: true, active_accounts: 7 }), { status: 200 });
      }
      if (url === "http://host.docker.internal:20128/api/version") {
        return new Response(JSON.stringify({ currentVersion: "0.3.60" }), { status: 200 });
      }
      if (url === "http://host.docker.internal:20128/api/provider-nodes") {
        return new Response(JSON.stringify({
          nodes: [
            {
              id: "node-agm",
              prefix: "agm",
              apiType: "chat",
              baseUrl: "http://host.docker.internal:8045/v1"
            }
          ]
        }), { status: 200 });
      }
      if (url === "http://host.docker.internal:20128/api/providers") {
        return new Response(JSON.stringify({
          connections: [
            {
              provider: "node-agm",
              isActive: true,
              defaultModel: "agm/gpt-4o-mini",
              providerSpecificData: {
                prefix: "agm",
                apiType: "chat",
                baseUrl: "http://host.docker.internal:8045/v1"
              }
            }
          ]
        }), { status: 200 });
      }
      if (url === "http://host.docker.internal:20129/health") {
        return new Response(JSON.stringify({
          status: "ok",
          model_aliases: ["pplxapp/app-chat"],
          runtime_target_available: true
        }), { status: 200 });
      }
      if (url === "http://host.docker.internal:9233/json/version") {
        return new Response(JSON.stringify({ Browser: "Perplexity/1.0" }), { status: 200 });
      }
      if (url === "http://host.docker.internal:8083/health") {
        return new Response(JSON.stringify({
          status: "ok",
          model_aliases: ["bbxapp/app-agent"],
          state_db_path: "C:/Users/test/AppData/Roaming/BLACKBOXAI/User/globalStorage/state.vscdb",
          state_db_exists: true,
          identity_loaded: true,
          user_id: "user-123",
          upstream_base_url: "https://bbx.example/v1"
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

    assert.equal(snapshot.antigravity.base_url, "http://host.docker.internal:8045");
    assert.equal(snapshot.router9.base_url, "http://host.docker.internal:20128");
    assert.equal(snapshot.perplexity?.manager_base_url, "http://host.docker.internal:20129");
    assert.equal(snapshot.blackbox?.manager_base_url, "http://host.docker.internal:8083");
  } finally {
    if (previousDefaultHost === undefined) {
      delete process.env.CODEX_HEAD_LOCALSTACK_HOST;
    } else {
      process.env.CODEX_HEAD_LOCALSTACK_HOST = previousDefaultHost;
    }
  }
});
