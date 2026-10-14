import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Claude's tools whose `description` input says what the call does (Paseo names subagent calls Task).
export const DESCRIBED_TOOLS = new Set(["Bash", "Monitor", "Agent", "Task"]);

// A step description or a recap, with when Claude wrote it (ISO time).
const updateSchema = z.object({ text: z.string(), at: z.string() });
export type Update = z.infer<typeof updateSchema>;

// Claude's descriptions of its calls since the last prompt. With `callId`, waits until that call
// is logged.
export const stepsRpc = defineRpc({
  name: "steps",
  input: z.object({ agentId: z.string(), callId: z.string().optional() }),
  output: z.object({ steps: z.array(updateSchema) }),
});

// A recap in Claude Code's style of the agent's last turn, made when the turn ends, or when asked
// if the daemon missed that.
export const recapRpc = defineRpc({
  name: "recap",
  input: z.object({ agentId: z.string() }),
  output: z.object({ recap: updateSchema.nullable() }),
});
