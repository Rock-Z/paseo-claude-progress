import { execFile } from "node:child_process";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { DESCRIBED_TOOLS, type recapRpc, type stepsRpc, type Update } from "../shared/rpc";

type Paseo = PluginHandlerContext["paseo"];

interface Step extends Update {
  callId: string;
}

// What has been read of one session log, so each call only reads what Claude appended since; and
// what a recap needs: the session's first request, the latest one, and Claude's reply to it.
interface LogState {
  offset: number;
  partial: string;
  steps: Step[];
  goal?: string;
  request?: string;
  reply?: string;
  replyId?: string;
  read: Promise<void>;
}

const POLL_MS = 500;
// Stays under Paseo's 30 s plugin call timeout; a call held at a permission prompt is logged later.
const STEP_WAIT_MS = 20_000;
// Claude Code's own recap instruction (unchanged from 2.1.284 through 2.1.299), applied to a condensed transcript.
// Reused verbatim so recaps read like Claude Code's own "while you were away" recaps, not a prompt of our own tuning.
const RECAP_PROMPT =
  "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.";
// A one-off Claude Code call with no settings, tools, MCP servers or session file of its own.
const RECAP_COMMAND = [
  "-p",
  "--setting-sources",
  "",
  "--tools",
  "",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--model",
  "haiku", // alias for the newest Haiku
];
const CLIP = 4000;
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
// Recaps are saved here with the reply they follow, so a daemon restart doesn't lose them.
const RECAP_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "claude-progress", "recaps");

const run = promisify(execFile);
const logs = new Map<string, LogState>();
// One recap per agent, kept until its next turn starts.
const recaps = new Map<string, Promise<Update | null>>();
// Claude agents mid-turn, from Paseo's turn hooks. Paseo can show an agent idle for a moment as its
// turn starts, so a client seeing a turn end isn't enough to make a recap.
const turns = new Set<string>();
// Recaps are made one at a time, so agents finishing together don't start a burst of processes.
let recapQueue: Promise<unknown> = Promise.resolve();

// Aborted when the plugin stops, so no poll or recap outlives the plugin's connection to Paseo.
export const stopping = new AbortController();

export function startTurn(agentId: string) {
  turns.add(agentId);
  recaps.delete(agentId);
}

export function endTurn(paseo: Paseo, agentId: string) {
  turns.delete(agentId);
  startRecap(paseo, agentId);
}

// Paseo's timeline drops the short description Claude writes for a tool call; Claude's session log
// keeps it. Paseo reports a call while it streams; Claude Code logs it once its input is complete.
export async function getSteps(
  { agentId, callId }: RpcInput<typeof stepsRpc>,
  { paseo }: PluginHandlerContext,
) {
  const path = await sessionLog(paseo, agentId);
  if (!path) return { steps: [] };
  for (let waited = 0; ; waited += POLL_MS) {
    const { steps } = await readLog(path);
    if (!callId || waited >= STEP_WAIT_MS || steps.some((step) => step.callId === callId)) {
      return { steps: steps.map(({ text, at }) => ({ text, at })) };
    }
    await sleep(POLL_MS, undefined, { signal: stopping.signal });
  }
}

export async function getRecap({ agentId, saved }: RpcInput<typeof recapRpc>, { paseo }: PluginHandlerContext) {
  // A client can see a turn end just before Paseo's hook does, or see one end that hasn't: wait for the hook.
  for (let waited = 0; turns.has(agentId) && waited < STEP_WAIT_MS; waited += POLL_MS) {
    await sleep(POLL_MS, undefined, { signal: stopping.signal });
  }
  if ((saved || turns.has(agentId)) && !recaps.has(agentId)) return { recap: await recapFor(paseo, agentId, false) };
  startRecap(paseo, agentId);
  return { recap: (await recaps.get(agentId)) ?? null };
}

// Called when a Claude turn ends, and by clients that see one end that the plugin missed. The hook
// doesn't wait for the recap, so a failure (such as the daemon connection closing mid-call) is
// caught here: unhandled, it would end the plugin's process. A failed recap is forgotten, so a
// client can ask for it again.
function startRecap(paseo: Paseo, agentId: string) {
  if (recaps.has(agentId)) return;
  const recap = recapFor(paseo, agentId).catch((error) => {
    console.error("Claude recap failed", error);
    if (recaps.get(agentId) === recap) recaps.delete(agentId);
    return null;
  });
  recaps.set(agentId, recap);
}

// The saved recap while Claude's last reply is the one it follows; otherwise a new one, if `make`.
async function recapFor(paseo: Paseo, agentId: string, make = true) {
  const path = await sessionLog(paseo, agentId);
  if (!path) return null;
  const file = join(RECAP_DIR, `${basename(path, ".jsonl")}.json`);
  const [{ replyId }, saved] = await Promise.all([
    readLog(path),
    readFile(file, "utf8").then(JSON.parse, () => null),
  ]);
  if (replyId && saved?.replyId === replyId) return saved.recap as Update;
  if (!make) return null;
  const recap = recapQueue.then(() => summarize(path, file));
  recapQueue = recap.catch(() => undefined);
  return recap;
}

async function summarize(path: string, file: string) {
  const log = await readLog(path);
  if (!log.reply) return null;
  const { replyId } = log;
  const transcript = [
    `Overall goal (the session's first request):\n${log.goal?.slice(0, CLIP)}`,
    `Latest request:\n${log.request?.slice(0, CLIP)}`,
    `Steps you took:\n${log.steps.map((step) => `- ${step.text}`).join("\n")}`,
    `Your final message:\n${log.reply.slice(0, CLIP)}`,
  ].join("\n\n");
  const prompt = `Condensed transcript of your session with the user:\n\n${transcript}\n\n${RECAP_PROMPT}`;
  const { stdout } = await run("claude", [...RECAP_COMMAND, prompt], { signal: stopping.signal });
  const recap = { text: stdout.trim(), at: new Date().toISOString() };
  await mkdir(RECAP_DIR, { recursive: true });
  await writeFile(file, JSON.stringify({ replyId, recap }));
  return recap;
}

// Null until the agent's Claude session has started.
async function sessionLog(paseo: Paseo, agentId: string) {
  const { agent } = (await paseo.agents.ref(agentId).refresh()) ?? {};
  const sessionId = agent?.persistence?.sessionId;
  if (!agent || !sessionId) return null;
  const project = (await realpath(agent.cwd)).replace(/[^a-zA-Z0-9]/g, "-");
  return join(CLAUDE_DIR, "projects", project, `${sessionId}.jsonl`);
}

// Reads are chained per log so two callers never parse the same bytes twice.
async function readLog(path: string) {
  const log = logs.get(path) ?? { offset: 0, partial: "", steps: [], read: Promise.resolve() };
  logs.set(path, log);
  const next = log.read.then(() => readAppended(path, log));
  log.read = next.catch(() => undefined);
  await next;
  return log;
}

async function readAppended(path: string, log: LogState) {
  // Claude Code creates the log with the session's first message.
  const file = await open(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!file) return;
  try {
    const { size } = await file.stat();
    const { buffer } = await file.read(Buffer.alloc(size - log.offset), 0, size - log.offset, log.offset);
    log.offset = size;
    const lines = (log.partial + buffer.toString("utf8")).split("\n");
    log.partial = lines.pop() ?? "";
    for (const line of lines) {
      const entry = JSON.parse(line);
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      // The user's prompts are text blocks; tool results, task notifications and injected context are not.
      if (entry.type === "user" && !entry.isMeta && content[0]?.type === "text") {
        log.goal ??= text;
        log.request = text;
        log.reply = undefined;
        log.replyId = undefined;
        log.steps = [];
      }
      if (entry.type !== "assistant") continue;
      if (text) {
        log.reply = text;
        log.replyId = entry.uuid;
      }
      for (const block of content) {
        const description = block.input?.description;
        if (block.type === "tool_use" && DESCRIBED_TOOLS.has(block.name) && typeof description === "string") {
          log.steps.push({ callId: block.id, text: description, at: entry.timestamp });
        }
      }
    }
  } finally {
    await file.close();
  }
}
