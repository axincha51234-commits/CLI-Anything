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

export interface LocalPerplexityManagerSnapshot {
  manager_base_url: string;
  manager_reachable: boolean;
  manager_status: string | null;
  manager_model_aliases: string[];
  cdp_base_url: string;
  cdp_reachable: boolean;
  cdp_browser: string | null;
  runtime_target_available: boolean | null;
  pplxapp_chat: LocalReviewStackRouteSnapshot;
}

export interface LocalBlackboxManagerSnapshot {
  manager_base_url: string;
  manager_reachable: boolean;
  manager_status: string | null;
  manager_model_aliases: string[];
  state_db_path: string | null;
  state_db_exists: boolean | null;
  identity_loaded: boolean | null;
  user_id_present: boolean | null;
  upstream_base_url: string | null;
  bbxapp_chat: LocalReviewStackRouteSnapshot;
}

export interface LocalReviewStackSnapshot {
  detected: boolean;
  helper_script_path: string;
  helper_script_available: boolean;
  helper_bootstrap_command: string | null;
  full_stack_helper_script_path: string;
  full_stack_helper_script_available: boolean;
  full_stack_bootstrap_command: string | null;
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
  perplexity?: LocalPerplexityManagerSnapshot;
  blackbox?: LocalBlackboxManagerSnapshot;
}

interface InspectLocalReviewStackOptions {
  fetch_impl?: typeof fetch;
  gui_config_path?: string;
  antigravity_port?: number;
  router_port?: number;
  perplexity_manager_port?: number;
  perplexity_bridge_port?: number;
  perplexity_cdp_port?: number;
  blackbox_manager_port?: number;
  blackbox_bridge_port?: number;
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
  const fullStackHelperScriptPath = join(appRoot, "scripts", "ensure-9router-full-stack.ps1");
  const guiConfigPath = options.gui_config_path ?? join(homedir(), ".antigravity_tools", "gui_config.json");
  const guiConfig = readGuiConfig(guiConfigPath, existsSyncFn, readFileSyncFn);
  const antigravityPort = options.antigravity_port
    ?? (typeof guiConfig.config?.proxy?.port === "number" ? guiConfig.config.proxy.port : 8045);
  const routerPort = options.router_port ?? 20128;
  const perplexityManagerPort = options.perplexity_manager_port ?? options.perplexity_bridge_port ?? 20129;
  const perplexityCdpPort = options.perplexity_cdp_port ?? 9233;
  const blackboxManagerPort = options.blackbox_manager_port ?? options.blackbox_bridge_port ?? 8083;
  const antigravityBaseUrl = `http://127.0.0.1:${antigravityPort}`;
  const routerBaseUrl = `http://127.0.0.1:${routerPort}`;
  const perplexityManagerBaseUrl = `http://127.0.0.1:${perplexityManagerPort}`;
  const perplexityCdpBaseUrl = `http://127.0.0.1:${perplexityCdpPort}`;
  const blackboxManagerBaseUrl = `http://127.0.0.1:${blackboxManagerPort}`;
  const helperScriptAvailable = existsSyncFn(helperScriptPath);
  const fullStackHelperScriptAvailable = existsSyncFn(fullStackHelperScriptPath);
  const helperBootstrapCommand = helperScriptAvailable
    ? `powershell -ExecutionPolicy Bypass -File "${helperScriptPath}"`
    : null;
  const fullStackBootstrapCommand = fullStackHelperScriptAvailable
    ? `powershell -ExecutionPolicy Bypass -File "${fullStackHelperScriptPath}"`
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
  const perplexityManagerHealth = await probeJson<{
    status?: string;
    model_aliases?: string[];
    runtime_target_available?: boolean;
  }>(
    fetchImpl,
    `${perplexityManagerBaseUrl}/health`
  );
  const perplexityCdpVersion = await probeJson<{ Browser?: string }>(
    fetchImpl,
    `${perplexityCdpBaseUrl}/json/version`
  );
  const blackboxManagerHealth = await probeJson<{
    status?: string;
    model_aliases?: string[];
    state_db_path?: string;
    state_db_exists?: boolean;
    identity_loaded?: boolean;
    user_id?: string;
    upstream_base_url?: string;
  }>(
    fetchImpl,
    `${blackboxManagerBaseUrl}/health`
  );

  const nodes = routerNodes.json?.nodes ?? [];
  const connections = routerConnections.json?.connections ?? [];
  const agmChat = resolveRouteState(nodes, connections, "agm", "chat");
  const agrResponses = resolveRouteState(nodes, connections, "agr", "responses");
  const pplxappChat = resolveRouteState(nodes, connections, "pplxapp", "chat");
  const bbxappChat = resolveRouteState(nodes, connections, "bbxapp", "chat");
  const antigravityReachable = antigravityHealth.reachable;
  const routerReachable = routerVersion.reachable;
  const recommendedReviewPathReady = antigravityReachable
    && routerReachable
    && (antigravityProxyStatus.json?.running ?? true) !== false
    && agmChat.present
    && agmChat.active_connection === true;
  const perplexityDetected = perplexityManagerHealth.reachable
    || perplexityCdpVersion.reachable
    || pplxappChat.present;
  const blackboxDetected = blackboxManagerHealth.reachable || bbxappChat.present;

  return {
    detected: helperScriptAvailable || guiConfig.exists || antigravityReachable || routerReachable || perplexityDetected || blackboxDetected,
    helper_script_path: helperScriptPath,
    helper_script_available: helperScriptAvailable,
    helper_bootstrap_command: helperBootstrapCommand,
    full_stack_helper_script_path: fullStackHelperScriptPath,
    full_stack_helper_script_available: fullStackHelperScriptAvailable,
    full_stack_bootstrap_command: fullStackBootstrapCommand,
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
    },
    ...(perplexityDetected ? {
      perplexity: {
        manager_base_url: perplexityManagerBaseUrl,
        manager_reachable: perplexityManagerHealth.reachable,
        manager_status: perplexityManagerHealth.json?.status ?? null,
        manager_model_aliases: perplexityManagerHealth.json?.model_aliases ?? [],
        cdp_base_url: perplexityCdpBaseUrl,
        cdp_reachable: perplexityCdpVersion.reachable,
        cdp_browser: perplexityCdpVersion.json?.Browser ?? null,
        runtime_target_available: perplexityManagerHealth.json?.runtime_target_available ?? null,
        pplxapp_chat: pplxappChat
      }
    } : {}),
    ...(blackboxDetected ? {
      blackbox: {
        manager_base_url: blackboxManagerBaseUrl,
        manager_reachable: blackboxManagerHealth.reachable,
        manager_status: blackboxManagerHealth.json?.status ?? null,
        manager_model_aliases: blackboxManagerHealth.json?.model_aliases ?? [],
        state_db_path: blackboxManagerHealth.json?.state_db_path ?? null,
        state_db_exists: blackboxManagerHealth.json?.state_db_exists ?? null,
        identity_loaded: blackboxManagerHealth.json?.identity_loaded ?? null,
        user_id_present: typeof blackboxManagerHealth.json?.user_id === "string"
          ? blackboxManagerHealth.json.user_id.trim().length > 0
          : null,
        upstream_base_url: blackboxManagerHealth.json?.upstream_base_url ?? null,
        bbxapp_chat: bbxappChat
      }
    } : {})
  };
}
