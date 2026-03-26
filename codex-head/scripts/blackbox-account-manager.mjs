#!/usr/bin/env node

import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function readCliArg(name) {
  const index = process.argv.findIndex((value) => value === `--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

const MANAGER_HOST = (readCliArg("host") ?? process.env.BLACKBOX_MANAGER_HOST ?? "127.0.0.1").trim();
const MANAGER_PORT = Number.parseInt((readCliArg("port") ?? process.env.BLACKBOX_MANAGER_PORT ?? "8083").trim(), 10);
const API_KEY = readCliArg("api-key") ?? process.env.BLACKBOX_MANAGER_API_KEY ?? "";
const STATE_DB_PATH = (readCliArg("state-db") ?? process.env.BLACKBOX_STATE_DB_PATH
  ?? join(homedir(), "AppData", "Roaming", "BLACKBOXAI", "User", "globalStorage", "state.vscdb")).trim();
const UPSTREAM_BASE_URL = (readCliArg("upstream-base-url") ?? process.env.BLACKBOX_UPSTREAM_BASE_URL
  ?? "https://oi-vscode-server-985058387028.europe-west1.run.app").trim().replace(/\/+$/, "");
const UPSTREAM_AUTH_TOKEN = (readCliArg("upstream-auth-token") ?? process.env.BLACKBOX_UPSTREAM_AUTH_TOKEN ?? "xxx").trim();
const CUSTOMER_ID = (readCliArg("customer-id") ?? process.env.BLACKBOX_CUSTOMER_ID ?? "placeholder").trim();
const DEFAULT_UPSTREAM_MODEL = (readCliArg("upstream-model") ?? process.env.BLACKBOX_UPSTREAM_MODEL
  ?? "custom/blackbox-base-2").trim();
const RAW_MODEL_ALIASES = (readCliArg("models") ?? process.env.BLACKBOX_MANAGER_MODELS ?? "bbxapp/app-agent")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const MODEL_ALIASES = Array.from(new Set([
  ...RAW_MODEL_ALIASES,
  ...RAW_MODEL_ALIASES
    .map((value) => value.includes("/") ? value.split("/").slice(1).join("/") : value)
    .filter(Boolean)
]));
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.BLACKBOX_MANAGER_REQUEST_TIMEOUT_MS ?? "180000", 10);
const IDENTITY_CACHE_TTL_MS = Number.parseInt(process.env.BLACKBOX_MANAGER_IDENTITY_CACHE_TTL_MS ?? "15000", 10);

const PYTHON_IDENTITY_SCRIPT = `
import json
import sqlite3
import sys

path = sys.argv[1]
conn = sqlite3.connect(path)
cur = conn.cursor()

def get_value(key):
    row = cur.execute("select value from ItemTable where key = ?", (key,)).fetchone()
    return row[0] if row else None

raw_agent_state = get_value("Blackboxapp.blackboxagent")
try:
    parsed_agent_state = json.loads(raw_agent_state) if raw_agent_state else {}
except Exception:
    parsed_agent_state = {}

agent_state = {
    "userId": parsed_agent_state.get("userId"),
    "blackbox_userId": parsed_agent_state.get("blackbox_userId"),
    "apiProvider": parsed_agent_state.get("apiProvider"),
    "dataSharingEnabled": parsed_agent_state.get("dataSharingEnabled"),
    "installed": parsed_agent_state.get("installed"),
}

payload = {
    "machineId": get_value("blackbox.app.machineId"),
    "userMachineId": get_value("blackbox.app.userMachineId"),
    "agentState": agent_state,
}
print(json.dumps(payload))
`;

let identityCache = {
  loadedAt: 0,
  value: null,
  error: null
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendError(response, statusCode, message, code = "manager_error", extra = {}) {
  sendJson(response, statusCode, {
    error: {
      code,
      message,
      ...extra
    }
  });
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Request body must be valid JSON.");
  }
  return parsed;
}

function requireAuthorized(request) {
  if (!API_KEY) {
    return true;
  }
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return false;
  }
  const normalized = String(authHeader).trim();
  return normalized === API_KEY || normalized === `Bearer ${API_KEY}`;
}

async function runPython(args) {
  const candidates = [];
  if (process.env.PYTHON) {
    candidates.push({
      file: process.env.PYTHON,
      args
    });
  }
  candidates.push({ file: "python", args });
  candidates.push({ file: "py", args: ["-3", ...args] });

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const result = await execFileAsync(candidate.file, candidate.args, {
        timeout: REQUEST_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      return result.stdout;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Unable to execute Python for BLACKBOXAI identity discovery.");
}

async function loadIdentity(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && identityCache.value && now - identityCache.loadedAt < IDENTITY_CACHE_TTL_MS) {
    return identityCache.value;
  }

  if (!existsSync(STATE_DB_PATH)) {
    const error = new Error(`BLACKBOXAI state database was not found at ${STATE_DB_PATH}.`);
    identityCache = {
      loadedAt: now,
      value: null,
      error
    };
    throw error;
  }

  try {
    const stdout = await runPython(["-c", PYTHON_IDENTITY_SCRIPT, STATE_DB_PATH]);
    const payload = safeJsonParse(stdout.trim());
    if (!payload || typeof payload !== "object") {
      throw new Error("BLACKBOXAI identity probe returned invalid JSON.");
    }

    const agentState = payload.agentState && typeof payload.agentState === "object" ? payload.agentState : {};
    const identity = {
      state_db_path: STATE_DB_PATH,
      machine_id: typeof payload.machineId === "string" ? payload.machineId : null,
      user_machine_id: typeof payload.userMachineId === "string" ? payload.userMachineId : null,
      user_id: typeof agentState.userId === "string"
        ? agentState.userId
        : typeof agentState.blackbox_userId === "string"
          ? agentState.blackbox_userId
          : null,
      api_provider: typeof agentState.apiProvider === "string" ? agentState.apiProvider : null,
      data_sharing_enabled: typeof agentState.dataSharingEnabled === "boolean" ? agentState.dataSharingEnabled : null,
      installed: typeof agentState.installed === "boolean" ? agentState.installed : null
    };

    if (!identity.user_id) {
      throw new Error("BLACKBOXAI identity probe did not return a userId.");
    }

    identityCache = {
      loadedAt: now,
      value: identity,
      error: null
    };
    return identity;
  } catch (error) {
    identityCache = {
      loadedAt: now,
      value: null,
      error: error instanceof Error ? error : new Error(String(error))
    };
    throw error;
  }
}

function buildUpstreamHeaders(identity) {
  return {
    Authorization: `Bearer ${UPSTREAM_AUTH_TOKEN}`,
    customerId: CUSTOMER_ID,
    userId: identity.user_id,
    version: "1.1",
    "content-type": "application/json"
  };
}

function normalizeRequestedModel(requestedModel) {
  if (!requestedModel || typeof requestedModel !== "string") {
    return DEFAULT_UPSTREAM_MODEL;
  }

  const normalized = requestedModel.trim();
  if (!normalized) {
    return DEFAULT_UPSTREAM_MODEL;
  }

  if (normalized === "app-agent" || normalized === "bbxapp/app-agent") {
    return DEFAULT_UPSTREAM_MODEL;
  }

  if (normalized.startsWith("bbxapp/")) {
    return normalized.slice("bbxapp/".length);
  }

  return normalized;
}

function buildModelsPayload() {
  return {
    object: "list",
    data: MODEL_ALIASES.map((model) => ({
      id: model,
      object: "model",
      created: 0,
      owned_by: "blackbox-account-manager"
    }))
  };
}

async function buildHealthPayload() {
  try {
    const identity = await loadIdentity();
    return {
      status: "ok",
      provider: "blackbox-account-manager",
      manager_base_url: `http://${MANAGER_HOST}:${MANAGER_PORT}`,
      state_db_path: STATE_DB_PATH,
      state_db_exists: true,
      identity_loaded: true,
      user_id: identity.user_id,
      api_provider: identity.api_provider,
      data_sharing_enabled: identity.data_sharing_enabled,
      upstream_base_url: UPSTREAM_BASE_URL,
      default_upstream_model: DEFAULT_UPSTREAM_MODEL,
      customer_id_mode: CUSTOMER_ID === "placeholder" ? "placeholder" : "configured",
      model_aliases: MODEL_ALIASES
    };
  } catch (error) {
    return {
      status: "degraded",
      provider: "blackbox-account-manager",
      manager_base_url: `http://${MANAGER_HOST}:${MANAGER_PORT}`,
      state_db_path: STATE_DB_PATH,
      state_db_exists: existsSync(STATE_DB_PATH),
      identity_loaded: false,
      upstream_base_url: UPSTREAM_BASE_URL,
      default_upstream_model: DEFAULT_UPSTREAM_MODEL,
      customer_id_mode: CUSTOMER_ID === "placeholder" ? "placeholder" : "configured",
      model_aliases: MODEL_ALIASES,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function forwardChatCompletion(payload) {
  const identity = await loadIdentity();
  const requestedModel = typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : (RAW_MODEL_ALIASES[0] ?? "bbxapp/app-agent");
  const upstreamModel = normalizeRequestedModel(requestedModel);
  const upstreamPayload = {
    ...payload,
    model: upstreamModel,
    stream: false
  };

  const response = await fetch(`${UPSTREAM_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: buildUpstreamHeaders(identity),
    body: JSON.stringify(upstreamPayload)
  });
  const text = await response.text();
  const json = safeJsonParse(text);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      payload: {
        error: {
          code: "upstream_failure",
          message: typeof json?.error?.message === "string"
            ? json.error.message
            : text.trim() || `BLACKBOX upstream failed with HTTP ${response.status}.`,
          upstream_status: response.status,
          upstream_model: upstreamModel,
          upstream_base_url: UPSTREAM_BASE_URL
        }
      }
    };
  }

  const result = json && typeof json === "object" ? json : {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: upstreamModel,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: text
        }
      }
    ]
  };

  return {
    ok: true,
    status: 200,
    payload: {
      ...result,
      model: requestedModel,
      manager: {
        provider: "blackbox-account-manager",
        upstream_model: upstreamModel,
        upstream_base_url: UPSTREAM_BASE_URL,
        state_db_path: STATE_DB_PATH,
        user_id: identity.user_id
      }
    }
  };
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    sendError(response, 404, "Route not found.", "not_found");
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? `${MANAGER_HOST}:${MANAGER_PORT}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    const payload = await buildHealthPayload();
    sendJson(response, payload.status === "ok" ? 200 : 503, payload);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, buildModelsPayload());
    return;
  }

  if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
    if (!requireAuthorized(request)) {
      sendError(response, 401, "Missing or invalid Blackbox manager API key.", "unauthorized");
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error), "invalid_json");
      return;
    }

    if (payload.stream) {
      sendError(response, 400, "Streaming is not supported by the Blackbox account manager.", "unsupported_stream");
      return;
    }

    try {
      const upstream = await forwardChatCompletion(payload);
      sendJson(response, upstream.status, upstream.payload);
      return;
    } catch (error) {
      sendError(
        response,
        502,
        error instanceof Error ? error.message : String(error),
        "upstream_failure",
        {
          upstream_base_url: UPSTREAM_BASE_URL
        }
      );
      return;
    }
  }

  sendError(response, 404, "Route not found.", "not_found");
});

server.listen(MANAGER_PORT, MANAGER_HOST, () => {
  console.log(`[${new Date().toISOString()}] Blackbox account manager listening on http://${MANAGER_HOST}:${MANAGER_PORT}`);
  console.log(`[${new Date().toISOString()}] State DB: ${STATE_DB_PATH}`);
  console.log(`[${new Date().toISOString()}] Upstream: ${UPSTREAM_BASE_URL}`);
  console.log(`[${new Date().toISOString()}] Models: ${MODEL_ALIASES.join(", ")}`);
});
