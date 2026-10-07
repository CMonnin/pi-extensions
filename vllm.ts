import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// --- Configuration ---
// Priority: 1) env vars, 2) ~/.vllm-creds file
//
// ~/.vllm-creds format (export lines, shell-compatible):
//   export VLLM_BASE_URL="https://vllm.your-org.com/v1"
//   export VLLM_API_KEY="sk-..."

function loadCredsFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(
        /^export\s+([A-Za-z0-9_]+)\s*=\s*(?:["']([^"']*)["']|([^\s#]*))/,
      );
      if (match) {
        vars[match[1]] = match[2] ?? match[3] ?? "";
      }
    }
  } catch {
    // File doesn't exist or unreadable
  }
  return vars;
}

const credsPath = resolve(homedir(), ".vllm-creds");
const fileCreds = loadCredsFile(credsPath);

const ORG_BASE_URL = process.env.VLLM_BASE_URL ?? fileCreds.VLLM_BASE_URL;
const ORG_API_KEY = process.env.VLLM_API_KEY ?? fileCreds.VLLM_API_KEY;
// ---------------------

export default async function (pi: ExtensionAPI) {
  // The OpenAI-compatible routes live under /v1 (/v1/models, /v1/chat/completions);
  // add it when the configured URL is just the host.
  const baseUrl = ORG_BASE_URL?.replace(/\/+$/, "").replace(/(?<!\/v1)$/, "/v1");
  const apiKey = ORG_API_KEY;

  if (!baseUrl) {
    console.error(
      "[vllm] Missing VLLM_BASE_URL. Set it via env var or add it to ~/.vllm-creds",
    );
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Only used when the server tells us nothing. Keep settings.json
  // compaction.reserveTokens at least as large as the output cap pi ends up
  // using (the server currently advertises 65536).
  const DEFAULT_CONTEXT_WINDOW = 40960;
  const DEFAULT_MAX_TOKENS = 8192;
  const DISCOVERY_TIMEOUT_MS = 3000;
  // Qwen3.x thinks by default; true lets pi send the thinking level and show
  // reasoning output. Set false if the server is not started with a reasoning parser.
  const REASONING = true;

  // Fallback specs, used only if discovery fails. Keep in sync with what the
  // server actually serves; when discovery succeeds these are ignored, so a
  // renamed or removed model never lingers as a selectable entry.
  const knownModels = [
    {
      id: "Qwen3.8-Flash-Next",
      name: "Qwen3.8-Flash-Next",
      reasoning: REASONING,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 65536,
    },
  ];

  let discovered: typeof knownModels = [];

  try {
    // Bounded so an unreachable host (off VPN) does not stall pi startup.
    const res = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const payload = (await res.json()) as {
      data: Array<{
        id: string;
        name?: string;
        // vLLM reports the served window here (input + output combined).
        max_model_len?: number;
        // A LiteLLM proxy reports these instead, from its model_info block.
        max_input_tokens?: number;
        max_output_tokens?: number;
        // Not emitted by vLLM or LiteLLM; kept for other OpenAI-compatible servers.
        context_window?: number;
        max_tokens?: number;
      }>;
    };

    if (payload.data?.length) {
      discovered = payload.data
        // A LiteLLM proxy publishes its catch-all route as a literal "*" entry;
        // it is a router rule, not a selectable model.
        .filter((model) => model.id !== "*")
        .map((model) => {
          const maxOutput =
            model.max_output_tokens ?? model.max_tokens ?? DEFAULT_MAX_TOKENS;
          // Prefer the server's own numbers. max_model_len is the total budget.
          // LiteLLM's max_input_tokens often already equals the full window, so
          // use it as-is: understating the window only compacts a little early,
          // overstating it makes vLLM reject requests past max_model_len.
          const contextWindow =
            model.max_model_len ??
            model.max_input_tokens ??
            model.context_window ??
            DEFAULT_CONTEXT_WINDOW;

          return {
            id: model.id,
            name: model.name ?? model.id,
            reasoning: REASONING,
            input: ["text"] as ("text" | "image")[],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            // Never let the output cap eat the window: prompt + max_tokens must
            // fit in max_model_len or vLLM rejects the request.
            maxTokens: Math.min(maxOutput, Math.floor(contextWindow / 4)),
          };
        });
      console.log(
        `[vllm] Discovered ${discovered.length} model(s): ` +
          discovered.map((m) => `${m.id} (ctx ${m.contextWindow})`).join(", "),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vllm] Discovery failed, using known models: ${msg}`);
  }

  const models = discovered.length ? discovered : knownModels;

  pi.registerProvider("vllm", {
    name: "vLLM",
    baseUrl,
    apiKey: apiKey ?? undefined,
    authHeader: !!apiKey,
    api: "openai-completions",
    models,
  });
}
