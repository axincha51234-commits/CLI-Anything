#!/usr/bin/env node

import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

function readCliArg(name) {
  const index = process.argv.findIndex((value) => value === `--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

const MANAGER_HOST = (
  readCliArg("host")
  ?? process.env.PERPLEXITY_MANAGER_HOST
  ?? process.env.PERPLEXITY_BRIDGE_HOST
  ?? "127.0.0.1"
).trim();
const MANAGER_PORT = Number.parseInt((
  readCliArg("port")
  ?? process.env.PERPLEXITY_MANAGER_PORT
  ?? process.env.PERPLEXITY_BRIDGE_PORT
  ?? "20129"
).trim(), 10);
const CDP_HOST = (readCliArg("cdp-host") ?? process.env.PERPLEXITY_CDP_HOST ?? "127.0.0.1").trim();
const CDP_PORT = Number.parseInt((readCliArg("cdp-port") ?? process.env.PERPLEXITY_CDP_PORT ?? "9233").trim(), 10);
const API_KEY = readCliArg("api-key")
  ?? process.env.PERPLEXITY_MANAGER_API_KEY
  ?? process.env.PERPLEXITY_BRIDGE_API_KEY
  ?? "";
const RAW_MODEL_ALIASES = (
  readCliArg("models")
  ?? process.env.PERPLEXITY_MANAGER_MODELS
  ?? process.env.PERPLEXITY_BRIDGE_MODELS
  ?? "pplxapp/app-chat,pplxapp/app-health"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const MODEL_ALIASES = Array.from(new Set([
  ...RAW_MODEL_ALIASES,
  ...RAW_MODEL_ALIASES
    .map((value) => value.includes("/") ? value.split("/").slice(1).join("/") : value)
    .filter(Boolean)
]));
const DEFAULT_MODEL = RAW_MODEL_ALIASES[0] ?? "pplxapp/app-chat";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.resolve(
  (
    readCliArg("session-file")
    ?? process.env.PERPLEXITY_MANAGER_SESSION_FILE
    ?? process.env.PERPLEXITY_BRIDGE_SESSION_FILE
    ?? path.join(SCRIPT_DIR, "..", "runtime", "perplexity-manager-sessions.json")
  ).trim()
);
const SESSION_KEY_HEADER = "x-perplexity-session-key";
const RESET_SESSION_HEADER = "x-perplexity-reset-session";
const SESSION_KEY_ALIASES = Object.freeze({
  "app-chat": "chat",
  "pplxapp/app-chat": "chat",
  "chat": "chat",
  "app-health": "health",
  "pplxapp/app-health": "health",
  "health": "health"
});
const FOLLOWUP_SUPPORTED_BLOCK_USE_CASES = Object.freeze([
  "answer_modes",
  "media_items",
  "knowledge_cards",
  "inline_entity_cards",
  "place_widgets",
  "finance_widgets",
  "prediction_market_widgets",
  "sports_widgets",
  "flight_status_widgets",
  "news_widgets",
  "shopping_widgets",
  "jobs_widgets",
  "search_result_widgets",
  "inline_images",
  "inline_assets",
  "placeholder_cards",
  "diff_blocks",
  "inline_knowledge_cards",
  "entity_group_v2",
  "refinement_filters",
  "canvas_mode",
  "maps_preview",
  "answer_tabs",
  "price_comparison_widgets",
  "preserve_latex",
  "generic_onboarding_widgets",
  "in_context_suggestions",
  "pending_followups",
  "inline_claims",
  "unified_assets",
  "workflow_steps",
  "background_agents"
]);

let requestChain = Promise.resolve();
let persistedSessionsPromise = null;
let persistedSessions = {
  version: 1,
  updated_at: null,
  sessions: {}
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

function compactNonEmptyString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isTruthyHeaderValue(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "reset";
}

function normalizeSessionKey(value) {
  const normalized = compactNonEmptyString(value)?.toLowerCase() ?? null;
  if (!normalized) {
    return "chat";
  }
  return SESSION_KEY_ALIASES[normalized] ?? normalized.replace(/[^a-z0-9._-]+/g, "-");
}

function cloneJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function summarizeSession(session) {
  if (!session || typeof session !== "object") {
    return null;
  }
  return {
    key: compactNonEmptyString(session.key) ?? null,
    thread_url_slug: compactNonEmptyString(session.thread_url_slug) ?? null,
    backend_uuid: compactNonEmptyString(session.backend_uuid) ?? null,
    context_uuid: compactNonEmptyString(session.context_uuid) ?? null,
    last_entry_uuid: compactNonEmptyString(session.last_entry_uuid) ?? null,
    display_model: compactNonEmptyString(session.display_model) ?? null,
    mode: compactNonEmptyString(session.mode) ?? null,
    search_focus: compactNonEmptyString(session.search_focus) ?? null,
    query_source: compactNonEmptyString(session.query_source) ?? null,
    updated_at: compactNonEmptyString(session.updated_at) ?? null
  };
}

function normalizePersistedSession(rawValue, key) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }
  const backendUuid = compactNonEmptyString(rawValue.backend_uuid);
  const readWriteToken = compactNonEmptyString(rawValue.read_write_token);
  if (!backendUuid || !readWriteToken) {
    return null;
  }
  const sources = Array.isArray(rawValue.sources)
    ? rawValue.sources.filter((entry) => typeof entry === "string" && entry.trim())
    : ["web"];
  return {
    key,
    backend_uuid: backendUuid,
    read_write_token: readWriteToken,
    thread_url_slug: compactNonEmptyString(rawValue.thread_url_slug),
    context_uuid: compactNonEmptyString(rawValue.context_uuid),
    last_entry_uuid: compactNonEmptyString(rawValue.last_entry_uuid),
    display_model: compactNonEmptyString(rawValue.display_model) ?? "turbo",
    model_preference: compactNonEmptyString(rawValue.model_preference) ?? "pplx_pro",
    mode: compactNonEmptyString(rawValue.mode) ?? "copilot",
    search_focus: compactNonEmptyString(rawValue.search_focus) ?? "internet",
    sources: sources.length > 0 ? sources : ["web"],
    query_source: compactNonEmptyString(rawValue.query_source) ?? "followup",
    updated_at: compactNonEmptyString(rawValue.updated_at) ?? new Date().toISOString()
  };
}

async function ensurePersistedSessionsLoaded() {
  if (!persistedSessionsPromise) {
    persistedSessionsPromise = (async () => {
      try {
        const rawText = await fs.readFile(SESSION_FILE, "utf8");
        const parsed = safeJsonParse(rawText);
        if (!parsed || typeof parsed !== "object") {
          return;
        }
        const nextSessions = {};
        const parsedSessions = parsed.sessions && typeof parsed.sessions === "object"
          ? parsed.sessions
          : {};
        for (const [key, value] of Object.entries(parsedSessions)) {
          const normalized = normalizePersistedSession(value, normalizeSessionKey(key));
          if (normalized) {
            nextSessions[normalized.key] = normalized;
          }
        }
        persistedSessions = {
          version: 1,
          updated_at: compactNonEmptyString(parsed.updated_at),
          sessions: nextSessions
        };
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn(`[${new Date().toISOString()}] Failed to load ${SESSION_FILE}: ${error.message ?? error}`);
        }
      }
    })();
  }
  await persistedSessionsPromise;
}

async function persistSessions() {
  await ensurePersistedSessionsLoaded();
  persistedSessions.updated_at = new Date().toISOString();
  await fs.mkdir(path.dirname(SESSION_FILE), { recursive: true });
  await fs.writeFile(SESSION_FILE, JSON.stringify(persistedSessions, null, 2), "utf8");
}

async function getStoredSession(sessionKey) {
  await ensurePersistedSessionsLoaded();
  return cloneJson(persistedSessions.sessions[sessionKey] ?? null);
}

async function setStoredSession(sessionKey, rawSession) {
  await ensurePersistedSessionsLoaded();
  const normalized = normalizePersistedSession({
    ...rawSession,
    key: sessionKey,
    updated_at: new Date().toISOString()
  }, sessionKey);
  if (!normalized) {
    throw new Error(`Cannot persist Perplexity session '${sessionKey}' without backend_uuid and read_write_token.`);
  }
  persistedSessions.sessions[sessionKey] = normalized;
  await persistSessions();
  return cloneJson(normalized);
}

async function clearStoredSession(sessionKey = null) {
  await ensurePersistedSessionsLoaded();
  if (sessionKey) {
    delete persistedSessions.sessions[sessionKey];
  } else {
    persistedSessions.sessions = {};
  }
  await persistSessions();
}

async function getSessionSummaryMap() {
  await ensurePersistedSessionsLoaded();
  return Object.fromEntries(
    Object.entries(persistedSessions.sessions).map(([key, session]) => [key, summarizeSession(session)])
  );
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

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (!entry || typeof entry !== "object") {
        return "";
      }
      if (entry.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }
      return "";
    })
    .join("\n")
    .trim();
}

function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("chat.completions requests require a non-empty messages array.");
  }

  const lines = messages
    .map((message) => {
      if (!message || typeof message !== "object") {
        return null;
      }
      const role = typeof message.role === "string" ? message.role.trim() : "user";
      const content = normalizeMessageContent(message.content);
      if (!content) {
        return null;
      }
      if (messages.length === 1 && role === "user") {
        return content;
      }
      return `${role.toUpperCase()}: ${content}`;
    })
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("chat.completions messages did not contain any text content.");
  }

  return lines.join("\n\n");
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

function resolveSessionKey(request, payload, requestedModel) {
  const headerValue = request.headers[SESSION_KEY_HEADER];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return normalizeSessionKey(headerValue);
  }
  const payloadSessionKey = payload?.perplexity_session_key
    ?? payload?.metadata?.perplexity_session_key
    ?? payload?.metadata?.session_key;
  if (typeof payloadSessionKey === "string" && payloadSessionKey.trim()) {
    return normalizeSessionKey(payloadSessionKey);
  }
  return normalizeSessionKey(requestedModel);
}

function shouldResetSession(request, payload) {
  const headerValue = request.headers[RESET_SESSION_HEADER];
  if (typeof headerValue === "string" && isTruthyHeaderValue(headerValue)) {
    return true;
  }
  return payload?.perplexity_reset_session === true
    || payload?.metadata?.perplexity_reset_session === true;
}

function quoteJs(value) {
  return JSON.stringify(value);
}

function serializeRequest(handler) {
  const run = requestChain.then(handler, handler);
  requestChain = run.then(() => undefined, () => undefined);
  return run;
}

async function fetchTargets() {
  const response = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  if (!response.ok) {
    throw new Error(`Perplexity CDP target listing failed with HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Perplexity CDP target listing did not return an array.");
  }
  return payload;
}

async function fetchVersion() {
  const response = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
  if (!response.ok) {
    throw new Error(`Perplexity CDP version probe failed with HTTP ${response.status}.`);
  }
  return response.json();
}

function isPageTarget(target) {
  return target && target.type === "page" && typeof target.webSocketDebuggerUrl === "string";
}

function findInputTarget(targets) {
  const pages = targets.filter(isPageTarget);
  return pages.find((target) => typeof target.url === "string" && target.url.includes("/windows-app/ask/input"))
    ?? pages.find((target) => target.url === "https://www.perplexity.ai/")
    ?? null;
}

class CdpSession {
  static async connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const session = new CdpSession(ws);
      ws.addEventListener("open", () => resolve(session), { once: true });
      ws.addEventListener("error", (event) => {
        reject(new Error(`Failed to connect to CDP target ${url}: ${event.message ?? "unknown error"}`));
      }, { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();

    ws.addEventListener("message", (event) => {
      const message = safeJsonParse(String(event.data));
      if (!message || typeof message !== "object" || typeof message.id !== "number") {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
        return;
      }
      pending.resolve(message.result ?? {});
    });

    ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("CDP target closed before the command completed."));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails?.text
        ?? result.result?.description
        ?? "Unknown evaluation error.";
      throw new Error(description);
    }
    return result?.result?.value ?? null;
  }

  async close() {
    try {
      this.ws.close();
    } catch {
      // Ignore close failures.
    }
  }
}

async function withInputSession(callback) {
  const target = findInputTarget(await fetchTargets());
  if (!target) {
    throw new Error("Perplexity input page is not available. Open the app first.");
  }
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    return await callback(session);
  } finally {
    await session.close();
  }
}

async function inspectManagerHealth() {
  try {
    const [version, targets, sessions] = await Promise.all([
      fetchVersion(),
      fetchTargets(),
      getSessionSummaryMap()
    ]);
    const inputTarget = findInputTarget(targets);
    return {
      status: "ok",
      provider: "perplexity-runtime-manager",
      manager_port: MANAGER_PORT,
      cdp_port: CDP_PORT,
      session_file: SESSION_FILE,
      active_session_count: Object.keys(sessions).length,
      sessions,
      browser: version?.Browser ?? null,
      model_aliases: MODEL_ALIASES,
      runtime_target_available: Boolean(inputTarget),
      target_count: targets.length,
      execution_mode: "runtime_sse"
    };
  } catch (error) {
    return {
      status: "degraded",
      provider: "perplexity-runtime-manager",
      manager_port: MANAGER_PORT,
      cdp_port: CDP_PORT,
      session_file: SESSION_FILE,
      model_aliases: MODEL_ALIASES,
      execution_mode: "runtime_sse",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildAskEndpoint(sessionState) {
  const querySource = sessionState ? "followup" : "default_search";
  return `/rest/sse/perplexity_ask?version=2.18&source=default&query_source=${encodeURIComponent(querySource)}`;
}

function buildAskBodyExpression(query, sessionState) {
  const serializedSession = quoteJs(JSON.stringify(sessionState ?? null));
  return `(() => {
    const sessionState = JSON.parse(${serializedSession});
    const endpoint = ${quoteJs(buildAskEndpoint(sessionState))};
    const frontendUuid = crypto.randomUUID();
    const baseParams = {
      frontend_uuid: frontendUuid,
      language: navigator.language || "en-US",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      search_focus: sessionState?.search_focus || "internet",
      sources: Array.isArray(sessionState?.sources) && sessionState.sources.length > 0 ? sessionState.sources : ["web"],
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      is_incognito: false,
      extended_context: false,
      supported_features: ["browser_agent_permission_banner_v1.1"]
    };
    const params = sessionState
      ? {
          ...baseParams,
          last_backend_uuid: sessionState.backend_uuid,
          read_write_token: sessionState.read_write_token,
          mode: sessionState.mode || "copilot",
          model_preference: sessionState.model_preference || "pplx_pro",
          is_related_query: false,
          is_sponsored: false,
          prompt_source: "user",
          query_source: "followup",
          time_from_first_type: 0,
          local_search_enabled: false,
          supported_block_use_cases: ${quoteJs(FOLLOWUP_SUPPORTED_BLOCK_USE_CASES)},
          client_coordinates: null,
          mentions: [],
          skip_search_enabled: true,
          is_nav_suggestions_disabled: false,
          followup_source: "manager",
          source: "windowsapp",
          always_search_override: false,
          override_no_search: false,
          should_ask_for_mcp_tool_confirmation: true,
          force_enable_browser_agent: false,
          version: "2.18"
        }
      : {
          ...baseParams,
          supported_block_use_cases: [],
          query_source: "default_search",
          mode: "concise"
        };
    const body = {
      query_str: ${quoteJs(query)},
      params
    };
    return fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }).then(async (response) => ({
      status: response.status,
      ok: response.ok,
      endpoint,
      frontendUuid,
      body,
      text: await response.text()
    }));
  })()`;
}

function looksLikeSessionFailure(text) {
  const normalized = String(text ?? "").toLowerCase();
  return normalized.includes("invalidthread")
    || normalized.includes("thread not found")
    || normalized.includes("invalid uuid or slug")
    || normalized.includes("\"detail\":{\"error_code\":\"bad_request\"");
}

function extractSessionStateFromAskResult(askResult) {
  const extracted = extractAskResult(askResult, "");
  const completedPayload = extracted.completed_payload ?? {};
  const answerPayload = extracted.answer_payload ?? {};
  const readWriteToken = compactNonEmptyString(completedPayload.read_write_token)
    ?? compactNonEmptyString(answerPayload.read_write_token);
  const backendUuid = compactNonEmptyString(completedPayload.backend_uuid);
  if (!backendUuid || !readWriteToken) {
    return null;
  }
  return {
    backend_uuid: backendUuid,
    read_write_token: readWriteToken,
    thread_url_slug: compactNonEmptyString(completedPayload.thread_url_slug),
    context_uuid: compactNonEmptyString(completedPayload.context_uuid),
    last_entry_uuid: compactNonEmptyString(completedPayload.uuid),
    display_model: compactNonEmptyString(completedPayload.display_model) ?? "turbo",
    model_preference: "pplx_pro",
    mode: compactNonEmptyString(completedPayload.mode)?.toLowerCase() === "concise" ? "copilot" : "copilot",
    search_focus: compactNonEmptyString(completedPayload.search_focus) ?? "internet",
    sources: ["web"],
    query_source: "followup"
  };
}

async function performAsk(query, sessionState) {
  return withInputSession(async (session) => {
    const expression = buildAskBodyExpression(query, sessionState);
    const result = await session.evaluate(expression);
    if (!result || typeof result !== "object") {
      throw new Error("Perplexity runtime ask returned an invalid payload.");
    }
    return result;
  });
}

async function runAsk(query, options = {}) {
  const sessionKey = normalizeSessionKey(options.sessionKey ?? "chat");
  const storedSession = options.forceFresh ? null : await getStoredSession(sessionKey);
  if (options.resetSession && storedSession) {
    await clearStoredSession(sessionKey);
  }

  let reusedSession = false;
  let sessionBefore = options.forceFresh ? null : (options.resetSession ? null : storedSession);
  let result = null;

  if (sessionBefore?.backend_uuid && sessionBefore?.read_write_token) {
    reusedSession = true;
    result = await performAsk(query, sessionBefore);
    if (!result.ok || looksLikeSessionFailure(result.text)) {
      await clearStoredSession(sessionKey);
      sessionBefore = null;
      reusedSession = false;
      result = await performAsk(query, null);
    }
  } else {
    result = await performAsk(query, null);
  }

  return {
    ...result,
    session_key: sessionKey,
    session_reused: reusedSession,
    session_before: summarizeSession(sessionBefore)
  };
}

function parseSseEvents(rawText) {
  return String(rawText ?? "")
    .split(/\r?\n\r?\n/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/g);
      const event = lines
        .filter((line) => line.startsWith("event:"))
        .map((line) => line.slice("event:".length).trim())
        .join("\n") || null;
      const dataText = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      return {
        event,
        data: safeJsonParse(dataText) ?? dataText
      };
    });
}

function parseAnswerEnvelope(text) {
  const steps = safeJsonParse(text);
  if (!Array.isArray(steps)) {
    return null;
  }

  const finalStep = steps.find((step) => step && typeof step === "object" && step.step_type === "FINAL");
  const answerPayload = finalStep?.content?.answer;
  const parsedAnswerPayload = typeof answerPayload === "string"
    ? safeJsonParse(answerPayload)
    : (answerPayload && typeof answerPayload === "object" ? answerPayload : null);

  return {
    steps,
    answer_payload: parsedAnswerPayload,
    answer_text: typeof parsedAnswerPayload?.answer === "string"
      ? parsedAnswerPayload.answer.trim()
      : null
  };
}

function extractStructuredAnswerText(answerPayload) {
  if (!answerPayload || typeof answerPayload !== "object") {
    return null;
  }

  const structuredAnswer = Array.isArray(answerPayload.structured_answer)
    ? answerPayload.structured_answer
    : [];
  const markdownBlock = structuredAnswer.find((block) => (
    block
    && typeof block === "object"
    && block.type === "markdown"
    && typeof block.text === "string"
    && block.text.trim()
  ));
  if (markdownBlock) {
    return markdownBlock.text.trim();
  }

  if (Array.isArray(answerPayload.chunks) && answerPayload.chunks.length > 0) {
    return answerPayload.chunks
      .filter((chunk) => typeof chunk === "string" && chunk.trim())
      .join("")
      .trim() || null;
  }

  return null;
}

function extractAskResult(askResult, prompt) {
  const events = parseSseEvents(askResult.text);
  const messagePayloads = events
    .filter((entry) => entry.event === "message" && entry.data && typeof entry.data === "object")
    .map((entry) => entry.data);
  const completedPayload = [...messagePayloads].reverse().find((entry) => (
    entry.status === "COMPLETED" && entry.final_sse_message === true
  )) ?? [...messagePayloads].reverse().find((entry) => entry.status === "COMPLETED") ?? null;

  if (!completedPayload) {
    throw new Error("Perplexity ask stream completed without a final answer payload.");
  }

  const envelope = typeof completedPayload.text === "string"
    ? parseAnswerEnvelope(completedPayload.text)
    : null;
  const answerPayload = envelope?.answer_payload ?? null;
  const citations = Array.isArray(answerPayload?.web_results)
    ? answerPayload.web_results.slice(0, 8).map((entry) => ({
        title: typeof entry?.name === "string" ? entry.name : (typeof entry?.title === "string" ? entry.title : null),
        url: typeof entry?.url === "string" ? entry.url : null,
        snippet: typeof entry?.snippet === "string" ? entry.snippet : null
      }))
    : [];
  const answer = envelope?.answer_text
    || extractStructuredAnswerText(answerPayload)
    || (typeof completedPayload.text === "string" && completedPayload.text.trim() ? completedPayload.text.trim() : null)
    || `Perplexity completed the ask flow but did not return a parseable answer for: ${prompt}`;

  return {
    answer,
    citations,
    events,
    completed_payload: completedPayload,
    answer_payload: answerPayload
  };
}

function createChatCompletionResponse(model, prompt, askResult) {
  const extracted = extractAskResult(askResult, prompt);
  const completedPayload = extracted.completed_payload;
  const sessionAfter = summarizeSession(askResult.session_after);

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: extracted.answer
        }
      }
    ],
    usage: {
      prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)),
      completion_tokens: Math.max(1, Math.ceil(extracted.answer.length / 4)),
      total_tokens: Math.max(2, Math.ceil((prompt.length + extracted.answer.length) / 4))
    },
    system_fingerprint: "perplexity-runtime-sse",
    manager: {
      provider: "perplexity-runtime-manager",
      transport: "sse_perplexity_ask",
      endpoint: askResult.endpoint ?? "/rest/sse/perplexity_ask",
      request_id: askResult.frontendUuid ?? completedPayload.frontend_uuid ?? null,
      backend_uuid: completedPayload.backend_uuid ?? null,
      thread_url_slug: completedPayload.thread_url_slug ?? null,
      result_count: extracted.citations.length,
      citations: extracted.citations,
      event_count: extracted.events.length,
      search_focus: completedPayload.search_focus ?? null,
      search_mode: completedPayload.search_mode ?? null,
      display_model: completedPayload.display_model ?? null,
      session_key: askResult.session_key ?? null,
      session_reused: askResult.session_reused === true,
      session_recovered: askResult.session_recovered === true,
      session_before: askResult.session_before ?? null,
      session_after: sessionAfter
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
    const health = await inspectManagerHealth();
    sendJson(response, health.status === "ok" ? 200 : 503, health);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, {
      object: "list",
      data: MODEL_ALIASES.map((model) => ({
        id: model,
        object: "model",
        created: 0,
        owned_by: "perplexity-runtime-manager"
      }))
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    sendJson(response, 200, {
      provider: "perplexity-runtime-manager",
      session_file: SESSION_FILE,
      sessions: await getSessionSummaryMap()
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/session/reset") {
    if (!requireAuthorized(request)) {
      sendError(response, 401, "Missing or invalid Perplexity runtime manager API key.", "unauthorized");
      return;
    }

    let payload = {};
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error), "invalid_json");
      return;
    }

    const requestedKey = normalizeSessionKey(
      compactNonEmptyString(payload?.session_key)
      ?? compactNonEmptyString(typeof request.headers[SESSION_KEY_HEADER] === "string" ? request.headers[SESSION_KEY_HEADER] : null)
      ?? "chat"
    );
    const clearAll = payload?.all === true;
    await clearStoredSession(clearAll ? null : requestedKey);
    sendJson(response, 200, {
      ok: true,
      cleared: clearAll ? "all" : requestedKey,
      sessions: await getSessionSummaryMap()
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    if (!requireAuthorized(request)) {
      sendError(response, 401, "Missing or invalid Perplexity runtime manager API key.", "unauthorized");
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
      sendError(response, 400, "Streaming is not supported by the Perplexity runtime manager.", "unsupported_stream");
      return;
    }

    const requestedModel = typeof payload.model === "string" && payload.model.trim()
      ? payload.model.trim()
      : DEFAULT_MODEL;
    if (!MODEL_ALIASES.includes(requestedModel)) {
      sendError(response, 400, `Unsupported model '${requestedModel}'.`, "unsupported_model", {
        supported_models: MODEL_ALIASES
      });
      return;
    }

    let prompt;
    try {
      prompt = buildPrompt(payload.messages);
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error), "invalid_messages");
      return;
    }

    const sessionKey = resolveSessionKey(request, payload, requestedModel);
    const resetSession = shouldResetSession(request, payload);

    try {
      let result = await serializeRequest(() => runAsk(prompt, {
        sessionKey,
        resetSession
      }));
      if (!result.ok) {
        throw new Error(result.text || `Perplexity runtime ask failed with HTTP ${result.status}.`);
      }

      let sessionAfter = null;
      try {
        sessionAfter = extractSessionStateFromAskResult(result);
      } catch (error) {
        if (result.session_reused) {
          await clearStoredSession(sessionKey);
          result = await serializeRequest(() => runAsk(prompt, {
            sessionKey,
            forceFresh: true
          }));
          if (!result.ok) {
            throw new Error(result.text || `Perplexity runtime ask failed with HTTP ${result.status}.`);
          }
          sessionAfter = extractSessionStateFromAskResult(result);
          result.session_recovered = true;
        } else {
          throw error;
        }
      }

      if (sessionAfter) {
        result.session_after = await setStoredSession(sessionKey, sessionAfter);
      }

      sendJson(response, 200, createChatCompletionResponse(requestedModel, prompt, result));
      return;
    } catch (error) {
      sendError(
        response,
        502,
        error instanceof Error ? error.message : String(error),
        "upstream_failure",
        { model: requestedModel, session_key: sessionKey }
      );
      return;
    }
  }

  sendError(response, 404, "Route not found.", "not_found");
});

server.listen(MANAGER_PORT, MANAGER_HOST, () => {
  console.log(`[${new Date().toISOString()}] Perplexity runtime manager listening on http://${MANAGER_HOST}:${MANAGER_PORT}`);
  console.log(`[${new Date().toISOString()}] CDP target: http://${CDP_HOST}:${CDP_PORT}`);
  console.log(`[${new Date().toISOString()}] Models: ${MODEL_ALIASES.join(", ")}`);
});
