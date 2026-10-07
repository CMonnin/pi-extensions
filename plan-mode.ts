import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Tools allowed in plan mode. Everything else (write, edit, powershell,
// codemode, MCP and other extension tools) is blocked, so new write-capable
// tools are denied by default instead of slipping through.
const ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);

// Read-only commands allowed as a pipeline segment. Matched on the first word.
const ALLOWED_COMMANDS = new Set([
  "cat", "head", "tail", "wc", "diff", "tree", "file", "stat", "uname",
  "echo", "grep", "rg", "find", "fd", "ls", "pwd", "which", "df", "du", "ps",
  "jq", "sort", "uniq", "cut", "basename", "dirname", "realpath", "git",
]);

// Read-only git subcommands. branch/remote only without arguments that modify.
const ALLOWED_GIT = new Set(["log", "status", "diff", "show", "branch", "remote"]);
const GIT_READ_ONLY_ARGS: Record<string, RegExp> = {
  branch: /^(-a|-r|-v|-vv|--list|--all|--remotes|--show-current)$/,
  remote: /^(-v|--verbose)$/,
};

// Shell syntax that can write files, chain commands or run arbitrary code.
// Pipes are handled separately: each segment must itself be allowed.
const FORBIDDEN_SYNTAX = /[;&><`\n]|\$\(|\|\|/;

// Per-command arguments that make an otherwise read-only command write files
// or run other programs.
const FORBIDDEN_ARGS: Record<string, RegExp> = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  fd: /^(-x|-X|--exec|--exec-batch)(=|$)/,
  rg: /^--pre(=|$)/,
  sort: /^(-o\S*|--output(=.*)?)$/,
  git: /^--output(=|$)/,
};

function isAllowedSegment(segment: string): boolean {
  const words = segment.trim().split(/\s+/);
  const [cmd, sub, ...rest] = words;
  if (!cmd || !ALLOWED_COMMANDS.has(cmd)) return false;
  const forbidden = FORBIDDEN_ARGS[cmd];
  if (forbidden && words.slice(1).some((arg) => forbidden.test(arg))) return false;
  if (cmd === "git") {
    if (!sub || !ALLOWED_GIT.has(sub)) return false;
    const argPattern = GIT_READ_ONLY_ARGS[sub];
    if (argPattern && !rest.every((arg) => argPattern.test(arg))) return false;
  }
  return true;
}

function isAllowedBash(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || FORBIDDEN_SYNTAX.test(cmd)) return false;
  return cmd.split("|").every(isAllowedSegment);
}

const PLAN_INSTRUCTIONS = `
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

Only use read, grep, find, ls, and simple read-only bash commands (no redirection,
chaining, or command substitution) to gather info. Do NOT call write, edit, or any
other tool that makes changes.
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

  // Inject planning instructions as a prompt section rather than replacing the
  // whole system prompt, so Pi records a delta and keeps the cached prefix.
  pi.on("before_agent_start", async (event, _ctx) => {
    if (planMode) {
      event.systemPromptOptions.sections.plan_mode = PLAN_INSTRUCTIONS;
    } else {
      delete event.systemPromptOptions.sections.plan_mode;
    }
  });

  // Block anything that is not explicitly read-only
  pi.on("tool_call", async (event, _ctx) => {
    if (!planMode) return;

    if (!ALLOWED_TOOLS.has(event.toolName)) {
      return { block: true, reason: `Plan mode: ${event.toolName} is disabled` };
    }

    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      if (!isAllowedBash(cmd)) {
        return {
          block: true,
          reason:
            "Plan mode: only simple read-only commands are allowed " +
            "(no redirection, chaining, or command substitution)",
        };
      }
    }
  });
}
