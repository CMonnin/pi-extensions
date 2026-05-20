import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
      const match = trimmed.match(/^export\s+([A-Za-z0-9_]+)\s*=\s*(?:["']([^"']*)["']|([^\s#]*))/);
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
  const baseUrl = ORG_BASE_URL?.replace(/\/$/, "");
  const apiKey = ORG_API_KEY;

  if (!baseUrl) {
    console.error(
      "[vllm] Missing VLLM_BASE_URL. Set it via env var or add it to ~/.vllm-creds"
    );
    return;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Known model from org config — ensures exact specs even if discovery fails
  const knownModels = [
    {
      id: "Qwen/Qwen3.6-27B-FP8",
      name: "Qwen3.6 27B FP8",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 40960,
      maxTokens: 4096,
    },
  ];

  let discovered: typeof knownModels = [];

  try {
    const res = await fetch(`${baseUrl}/models`, { headers });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const payload = (await res.json()) as {
      data: Array<{
        id: string;
        name?: string;
        context_window?: number;
        max_tokens?: number;
      }>;
    };

    if (payload.data?.length) {
      discovered = payload.data.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        reasoning: false,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.context_window ?? 40960,
        maxTokens: model.max_tokens ?? 4096,
      }));
      console.log(`[vllm] Discovered ${discovered.length} model(s)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vllm] Discovery failed, using known models: ${msg}`);
  }

  // Merge: discovered models take precedence, but keep known specs for known IDs
  const modelMap = new Map<string, (typeof knownModels)[number]>();
  for (const m of knownModels) modelMap.set(m.id, m);
  for (const m of discovered) modelMap.set(m.id, m);

  pi.registerProvider("vllm", {
    name: "vLLM",
    baseUrl,
    apiKey: apiKey ?? undefined,
    authHeader: !!apiKey,
    api: "openai-completions",
    models: Array.from(modelMap.values()),
  });
}
