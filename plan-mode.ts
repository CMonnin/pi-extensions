import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Bash commands allowed in plan mode (read-only operations)
const ALLOWED_BASH = [
  "cat ", "head ", "tail ", "wc ", "diff ", "git log", "git status",
  "git diff", "git show", "git branch", "git remote", "git diff",
  "tree", "file ", "stat ", "uname", "env", "echo ",
  "grep ", "find ", "ls ", "pwd", "which ", "command -v",
  "df ", "du ", "ps ", "top", "htop",
  "curl ", "wget --spider",
  "python -c", "node -e", "jq ",
];

// Patterns that indicate a write/modify operation
const WRITE_PATTERNS = [
  "^rm\\b", "^rmdir", "^mv\\b", "^cp\\b", "^chmod", "^chown",
  "^mkdir", "^touch\\b", "^dd\\b", "^truncate",
  "sed -i", "\\|\\s*tee",
  "apt\\b", "yum\\b", "pip install", "npm install", "pnpm install", "bun install",
  "git commit", "git push", "git checkout", "git merge", "git rebase",
];

function isWriteCommand(cmd: string): boolean {
  const line = cmd.trim().split("\n")[0].trim();
  return WRITE_PATTERNS.some((p) => {
    try { return new RegExp(p, "i").test(line); }
    catch { return line.toLowerCase().includes(p.toLowerCase()); }
  });
}

function isAllowedBash(cmd: string): boolean {
  const line = cmd.trim().split("\n")[0].trim();
  return ALLOWED_BASH.some((p) => line.toLowerCase().startsWith(p.toLowerCase()));
}

const PLAN_INSTRUCTIONS = `
---
PLAN MODE — Read-only. Do NOT execute any changes.

Produce a structured plan in this format:

## Understanding
[Brief restatement of the goal and constraints]

## Analysis
[What exists, what needs to change, dependencies, risks]

## Plan
1. **Step 1** — [description]
   - Files: \`path/to/file\`
   - Details: [what exactly]
2. **Step 2** — ...

## Estimated Effort
[Small / Medium / Large]

## Risks
[Caveats, edge cases, things to verify]

Only use read, grep, find, ls to gather info. Do NOT call write, edit, or bash to make changes.
`.trim();

export default function (pi: ExtensionAPI) {
  // Register --plan CLI flag (must be placed AFTER the message)
  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only, no execution). Place after message: pi \"prompt\" --plan",
    type: "boolean",
    default: false,
  });

  let planMode = false;

  pi.on("session_start", async (_event, _ctx) => {
    planMode = pi.getFlag("plan");
    if (planMode) {
      console.log("[plan-mode] activated");
      _ctx.ui?.notify("Plan mode — read-only, no execution", "info");
    }
  });

  // /plan command to toggle at runtime
  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only, no execution)",
    handler: async (_args, ctx) => {
      planMode = !planMode;
      if (planMode) {
        ctx.ui.notify("Plan mode ON", "info");
      } else {
        ctx.ui.notify("Plan mode OFF", "info");
      }
    },
  });

  // Inject planning instructions
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!planMode) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + PLAN_INSTRUCTIONS,
    };
  });

  // Block write operations
  pi.on("tool_call", async (event, _ctx) => {
    if (!planMode) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      return { block: true, reason: "Plan mode: write tools disabled" };
    }

    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      if (isWriteCommand(cmd) && !isAllowedBash(cmd)) {
        return { block: true, reason: "Plan mode: write commands blocked" };
      }
    }
  });
}
