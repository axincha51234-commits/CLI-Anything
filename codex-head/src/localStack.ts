import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface AntigravityGuiConfig {
  proxy?: {
    port?: number;
    auto_start?: boolean;
    auth_mode?: string;
    api_key?: string;
  };
  auto_launch?: boolean;
}

interface JsonProbeResult<T> {
  reachable: boolean;
  status: number | null;
  json: T | null;
  error: string | null;
}

interface NineRouterNode {
  id?: string;
  prefix?: string;
  apiType?: string;
  baseUrl?: string;
}

interface NineRouterConnection {
  provider?: string;
  isActive?: boolean;
  defaultModel?: string;
  providerSpecificData?: {
    prefix?: string;
    apiType?: string;
    baseUrl?: string;
  };
}

export interface LocalReviewStackRouteSnapshot {
  prefix: string;
  api_type: "chat" | "responses";
  present: boolean;
  active_connection: boolean | null;
  default_model: string | null;
  upstream_base_url: string | null;
}

export interface LocalReviewStackSnapshot {
  detected: boolean;
  helper_script_path: string;
  helper_script_available: boolean;
  helper_bootstrap_command: string | null;
  gui_config_path: string;
  gui_config_exists: boolean;
  recommended_review_path_ready: boolean;
  antigravity: {
    base_url: string;
    port: number;
    reachable: boolean;
    version: string | null;
    auto_start: boolean | null;
    auto_launch: boolean | null;
    auth_mode: string | null;
    api_key_configured: boolean;
    proxy_status_available: boolean;
    running: boolean | null;
    active_accounts: number | null;
  };
  router9: {
    base_url: string;
    reachable: boolean;
    version: string | null;
    agm_chat: LocalReviewStackRouteSnapshot;
    agr_responses: LocalReviewStackRouteSnapshot;
    responses_route_suitable_for_codex_cli_local: boolean;
  };
}

interface InspectLocalReviewStackOptions {
  fetch_impl?: typeof fetch;
  gui_config_path?: string;
  antigravity_port?: number;
  router_port?: number;
  exists_sync?: (path: string) => boolean;
  read_file_sync?: (path: string, encoding: BufferEncoding) => string;
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function probeJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit
): Promise<JsonProbeResult<T>> {
  try {
    const response = await fetchImpl(url, init);
    const text = await response.text();
    return {
      reachable: response.ok,
      status: response.status,
      json: safeJsonParse<T>(text),
      error: response.ok ? null : text.trim() || `${response.status}`
    };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      json: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function readGuiConfig(
  guiConfigPath: string,
  existsSyncFn: (path: string) => boolean,
  readFileSyncFn: (path: string, encoding: BufferEncoding) => string
): {
  exists: boolean;
  config: AntigravityGuiConfig | null;
} {
  if (!existsSyncFn(guiConfigPath)) {
    return {
      exists: false,
      config: null
    };
  }

  try {
    const parsed = JSON.parse(readFileSyncFn(guiConfigPath, "utf8")) as AntigravityGuiConfig;
    return {
      exists: true,
      config: parsed
    };
  } catch {
    return {
      exists: true,
      config: null
    };
  }
}

function resolveRouteState(
  nodes: NineRouterNode[],
  connections: NineRouterConnection[],
  prefix: string,
  apiType: "chat" | "responses"
): LocalReviewStackRouteSnapshot {
  const matchingNodes = nodes.filter((entry) => entry.prefix === prefix && entry.apiType === apiType);
  const matchingConnection = connections.find((entry) => {
    const providerPrefix = entry.providerSpecificData?.prefix;
    const providerApiType = entry.providerSpecificData?.apiType;
    if (providerPrefix === prefix && providerApiType === apiType) {
      return true;
    }
    if (!entry.provider) {
      return false;
    }
    return matchingNodes.some((node) => node.id === entry.provider);
  });

  return {
    prefix,
    api_type: apiType,
    present: matchingNodes.length > 0,
    active_connection: matchingConnection ? Boolean(matchingConnection.isActive) : null,
    default_model: matchingConnection?.defaultModel ?? null,
    upstream_base_url: matchingConnection?.providerSpecificData?.baseUrl
      ?? matchingNodes[0]?.baseUrl
      ?? null
  };
}

export async function inspectLocalReviewStack(
  appRoot: string,
  options: InspectLocalReviewStackOptions = {}
): Promise<LocalReviewStackSnapshot> {
  const fetchImpl = options.fetch_impl ?? fetch;
  const existsSyncFn = options.exists_sync ?? existsSync;
  const readFileSyncFn = options.read_file_sync ?? ((path: string, encoding: BufferEncoding) => readFileSync(path, encoding));
  const helperScriptPath = join(appRoot, "scripts", "ensure-9router-antigravity-stack.ps1");
  const guiConfigPath = options.gui_config_path ?? join(homedir(), ".antigravity_tools", "gui_config.json");
  const guiConfig = readGuiConfig(guiConfigPath, existsSyncFn, readFileSyncFn);
  const antigravityPort = options.antigravity_port
    ?? (typeof guiConfig.config?.proxy?.port === "number" ? guiConfig.config.proxy.port : 8045);
  const routerPort = options.router_port ?? 20128;
  const antigravityBaseUrl = `http://127.0.0.1:${antigravityPort}`;
  const routerBaseUrl = `http://127.0.0.1:${routerPort}`;
  const helperScriptAvailable = existsSyncFn(helperScriptPath);
  const helperBootstrapCommand = helperScriptAvailable
    ? `powershell -ExecutionPolicy Bypass -File "${helperScriptPath}"`
    : null;

  const antigravityHealth = await probeJson<{ status?: string; version?: string }>(
    fetchImpl,
    `${antigravityBaseUrl}/health`
  );
  const antigravityProxyStatus = guiConfig.config?.proxy?.api_key
    ? await probeJson<{ running?: boolean; active_accounts?: number }>(
        fetchImpl,
        `${antigravityBaseUrl}/api/proxy/status`,
        {
          headers: {
            Authorization: `Bearer ${guiConfig.config.proxy.api_key}`
          }
        }
      )
    : {
        reachable: false,
        status: null,
        json: null,
        error: null
      };
  const routerVersion = await probeJson<{ currentVersion?: string }>(
    fetchImpl,
    `${routerBaseUrl}/api/version`
  );
  const routerNodes = await probeJson<{ nodes?: NineRouterNode[] }>(
    fetchImpl,
    `${routerBaseUrl}/api/provider-nodes`
  );
  const routerConnections = await probeJson<{ connections?: NineRouterConnection[] }>(
    fetchImpl,
    `${routerBaseUrl}/api/providers`
  );

  const nodes = routerNodes.json?.nodes ?? [];
  const connections = routerConnections.json?.connections ?? [];
  const agmChat = resolveRouteState(nodes, connections, "agm", "chat");
  const agrResponses = resolveRouteState(nodes, connections, "agr", "responses");
  const antigravityReachable = antigravityHealth.reachable;
  const routerReachable = routerVersion.reachable;
  const recommendedReviewPathReady = antigravityReachable
    && routerReachable
    && (antigravityProxyStatus.json?.running ?? true) !== false
    && agmChat.present
    && agmChat.active_connection === true;

  return {
    detected: helperScriptAvailable || guiConfig.exists || antigravityReachable || routerReachable,
    helper_script_path: helperScriptPath,
    helper_script_available: helperScriptAvailable,
    helper_bootstrap_command: helperBootstrapCommand,
    gui_config_path: guiConfigPath,
    gui_config_exists: guiConfig.exists,
    recommended_review_path_ready: recommendedReviewPathReady,
    antigravity: {
      base_url: antigravityBaseUrl,
      port: antigravityPort,
      reachable: antigravityReachable,
      version: antigravityHealth.json?.version ?? null,
      auto_start: guiConfig.config?.proxy?.auto_start ?? null,
      auto_launch: guiConfig.config?.auto_launch ?? null,
      auth_mode: guiConfig.config?.proxy?.auth_mode ?? null,
      api_key_configured: Boolean(guiConfig.config?.proxy?.api_key),
      proxy_status_available: Boolean(guiConfig.config?.proxy?.api_key) && antigravityProxyStatus.reachable,
      running: antigravityProxyStatus.json?.running ?? null,
      active_accounts: antigravityProxyStatus.json?.active_accounts ?? null
    },
    router9: {
      base_url: routerBaseUrl,
      reachable: routerReachable,
      version: routerVersion.json?.currentVersion ?? null,
      agm_chat: agmChat,
      agr_responses: agrResponses,
      responses_route_suitable_for_codex_cli_local: false
    }
  };
}
