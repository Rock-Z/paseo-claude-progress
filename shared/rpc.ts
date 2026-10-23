import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Claude's tools whose `description` input says what the call does (Paseo names subagent calls Task).
export const DESCRIBED_TOOLS = new Set(["Bash", "Monitor", "Agent", "Task"]);

// A step description or a recap, with when Claude wrote it (ISO time).
const updateSchema = z.object({ text: z.string(), at: z.string() });
export type Update = z.infer<typeof updateSchema>;

// A subagent still at work: its name, its latest step's description (empty before its first) and when,
// and for a workflow's agent, the workflow's summary.
const subagentSchema = z.object({ name: z.string(), text: z.string(), at: z.string(), group: z.string().optional() });
export type Subagent = z.infer<typeof subagentSchema>;

// One earlier round of the session: its steps, and its recap if one was made.
const roundSchema = z.object({ steps: z.array(updateSchema), recap: updateSchema.nullable() });
export type Round = z.infer<typeof roundSchema>;

// Claude's descriptions of its calls since the last prompt, and the subagents still at work. With
// `callId`, waits until that call is logged; without, also the earlier rounds.
export const stepsRpc = defineRpc({
  name: "steps",
  input: z.object({ agentId: z.string(), callId: z.string().optional() }),
  output: z.object({
    steps: z.array(updateSchema),
    subagents: z.array(subagentSchema),
    rounds: z.array(roundSchema).optional(),
  }),
});

// A recap in Claude Code's style of the agent's last turn, made when the turn ends, or when asked
// if the daemon missed that. With `saved`, only a recap already made: none is made for turns that
// ended before the plugin ran, so opening Paseo doesn't recap every idle agent.
export const recapRpc = defineRpc({
  name: "recap",
  input: z.object({ agentId: z.string(), saved: z.boolean().optional() }),
  output: z.object({ recap: updateSchema.nullable() }),
});
