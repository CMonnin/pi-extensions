import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Tools that are safe in plan mode (read-only)
const READ_ONLY_TOOLS = new Set([
  "read",
  "bash",       // allowed but blocked for write commands below
  "grep",
  "find",
  "ls",
]);

// Commands that modify the filesystem
const WRITE_PATTERNS = [
  "rm ", "rm$", "rmdir", "mv ", "cp ", "chmod", "chown",
  "mkdir", "touch ", "dd ", "truncate",
  "sed -i", "awk.*\\|.*tee",
  "apt ", "yum ", "pip install", "npm install", "pnpm install", "bun install",
  "git commit", "git push", "git checkout", "git merge", "git rebase",
];

// Bash commands allowed in plan mode (read-only operations)
const ALLOWED_BASH = [
  "cat ", "head ", "tail ", "wc ", "diff ", "git log", "git status",
  "git diff", "git show", "git branch", "git remote",
  "tree", "file ", "stat ", "uname", "env", "echo ",
  "grep ", "find ", "ls ", "pwd", "which ", "command -v",
  "df ", "du ", "ps ", "top", "htop",
  "curl ", "wget --spider",
  "python -c", "node -e", "jq ",
];

function isWriteCommand(cmd: string): boolean {
  const trimmed = cmd.trim().split("\n")[0].trim(); // first line only
  return WRITE_PATTERNS.some((p) => {
    try {
      return new RegExp(p, "i").test(trimmed);
    } catch {
      return trimmed.toLowerCase().includes(p.toLowerCase());
    }
  });
}

function isAllowedBash(cmd: string): boolean {
  const trimmed = cmd.trim().split("\n")[0].trim();
  return ALLOWED_BASH.some((p) => trimmed.toLowerCase().startsWith(p.toLowerCase()));
}

const PLAN_INSTRUCTIONS = `
---
PLAN MODE ACTIVE — Read-only. Do NOT execute any changes.

Your job is to analyze the request and produce a structured plan. Follow this format:

## Understanding
[Brief restatement of the goal and constraints]

## Analysis
[What exists now, what needs to change, dependencies, risks]

## Plan
1. **Step 1** — [description]
   - Files affected: \`path/to/file\`
   - Details: [what exactly to do]
2. **Step 2** — [description]
   ...

## Estimated Effort
[Small / Medium / Large + rough time estimate]

## Risks & Considerations
[Any caveats, edge cases, things to verify]

Do NOT call write, edit, or bash tools to make changes. Only use read, grep, find, and ls to gather information. If you need to run a command to understand the codebase, use read-only commands (git log, git status, cat, etc.).
`.trim();

export default function (pi: ExtensionAPI) {
  // Register --plan CLI flag
  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only, no execution)",
    type: "boolean",
    default: false,
  });

  let planMode = false;

  // Initialize plan mode from flag
  pi.on("session_start", async (_event, _ctx) => {
    planMode = pi.getFlag("plan");
    if (planMode) {
      pi.setActiveTools(Array.from(READ_ONLY_TOOLS));
      _ctx.ui?.notify("Plan mode enabled — read-only, no execution", "info");
    }
  });

  // Register /plan command to toggle at runtime
  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only, no execution)",
    handler: async (_args, ctx) => {
      planMode = !planMode;
      if (planMode) {
        pi.setActiveTools(Array.from(READ_ONLY_TOOLS));
        ctx.ui.notify("Plan mode ON — read-only, no execution", "info");
      } else {
        pi.setActiveTools(); // restore all tools
        ctx.ui.notify("Plan mode OFF — all tools restored", "info");
      }
    },
  });

  // Inject planning instructions before each agent turn in plan mode
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!planMode) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + PLAN_INSTRUCTIONS,
    };
  });

  // Safety net: block write commands even if model tries
  pi.on("tool_call", async (event, _ctx) => {
    if (!planMode) return;

    // Block all write tools directly
    if (event.toolName === "write" || event.toolName === "edit") {
      return { block: true, reason: "Plan mode: write tools are disabled" };
    }

    // Block destructive bash commands
    if (event.toolName === "bash") {
      const input = event.input as { command?: string };
      if (input.command && isWriteCommand(input.command) && !isAllowedBash(input.command)) {
        return { block: true, reason: "Plan mode: write commands are blocked" };
      }
    }

    return;
  });
}
