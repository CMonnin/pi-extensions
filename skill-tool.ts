import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";

// Claude Code-style `Skill` tool. Skills written for Claude Code (for example
// mattpocock/skills) say "Call the Skill tool with <name>"; pi has no such tool
// and only lists skill paths in the system prompt. This tool resolves a name
// against the skills pi loaded and returns its SKILL.md, so those skills work
// unchanged.

interface LoadedSkill {
  name: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}

const SkillParams = Type.Object({
  skill: Type.String({
    description: 'Skill name, e.g. "grilling". A "plugin:" prefix is ignored.',
  }),
  args: Type.Optional(Type.String({ description: "Optional arguments for the skill" })),
});

export default function (pi: ExtensionAPI) {
  // Refreshed before every run, so /reload and newly installed skills are picked up.
  let skills: LoadedSkill[] = [];

  pi.on("before_agent_start", async (event) => {
    skills = (event.systemPromptOptions.skills ?? []) as LoadedSkill[];
  });

  pi.registerTool({
    name: "Skill",
    label: "Skill",
    description:
      "Load a skill's instructions by name and follow them. Use when a skill " +
      "from the available skills list applies, or when instructions say to " +
      "call the Skill tool.",
    parameters: SkillParams,

    async execute(_toolCallId, params) {
      const name = params.skill.trim().replace(/^\/?(skill:)?/, "").split(":").pop()!;
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        const available = skills
          .filter((s) => !s.disableModelInvocation)
          .map((s) => s.name)
          .join(", ");
        throw new Error(`Unknown skill "${name}". Available: ${available}`);
      }
      if (skill.disableModelInvocation) {
        throw new Error(
          `Skill "${name}" is user-invoked only; the user can run it with /skill:${name}.`,
        );
      }

      const body = await readFile(skill.filePath, "utf-8");
      const header =
        `Skill "${name}" loaded. Base directory: ${skill.baseDir} ` +
        `(resolve relative paths in the skill against it).` +
        (params.args ? `\nArguments: ${params.args}` : "");
      return {
        content: [{ type: "text", text: `${header}\n\n${body}` }],
        details: undefined,
      };
    },
  });
}
