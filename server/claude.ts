import { execFile } from "node:child_process";
import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { DESCRIBED_TOOLS, type recapRpc, type stepsRpc, type Subagent, type Update } from "../shared/rpc";

type Paseo = PluginHandlerContext["paseo"];

interface Step extends Update {
  callId: string;
}

// What has been read of one session log, so each call only reads what Claude appended since; and
// what a recap needs: the session's first request, the latest one, and Claude's reply to it. Earlier
// rounds keep their steps and the reply their recap follows.
interface LogState {
  offset: number;
  partial: string;
  rounds: { steps: Step[]; replyId?: string }[];
  steps: Step[];
  goal?: string;
  request?: string;
  reply?: string;
  replyId?: string;
  // Calls whose result is logged; background calls (by call id) and tasks (by task id) that are over:
  // a final task notification names the call, TaskStop the task.
  results: Set<string>;
  ended: Set<string>;
  // Each background workflow's transcript directory, with the ids its end goes by.
  workflows: Map<string, string[]>;
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
// A task notification's call and a status other than running: the background call is over.
const TASK_DONE = /<task-notification>\s*<task-id>[^<]*<\/task-id>\s*<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>(?!running)/g;
// A subagent whose log hasn't changed for this long is taken as stopped, such as by a daemon restart.
const STALE_MS = 30 * 60_000;
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
// Recaps are saved here with the reply they follow, so a daemon restart doesn't lose them.
const RECAP_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "claude-progress", "recaps");

const run = promisify(execFile);
const logs = new Map<string, LogState>();
// When each subagent log was first seen, so subagents keep their order.
const firstSeen = new Map<string, number>();
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
  if (!path) return { steps: [], subagents: [] };
  let log = await readLog(path);
  for (let waited = 0; callId && waited < STEP_WAIT_MS; waited += POLL_MS) {
    if (log.steps.some((step) => step.callId === callId)) break;
    await sleep(POLL_MS, undefined, { signal: stopping.signal });
    log = await readLog(path);
  }
  const steps = log.steps.map(update);
  const subagents = await runningSubagents(path, log);
  if (callId) return { steps, subagents };
  // Without a call to wait for, the client is loading the agent: add the earlier rounds.
  const saved = await savedRecaps(recapFile(path));
  const rounds = log.rounds
    .map(({ steps, replyId }) => ({ steps: steps.map(update), recap: (replyId && saved[replyId]) || null }))
    .filter((round) => round.steps.length || round.recap);
  return { steps, subagents, rounds };
}

// The session's subagents still at work, each with its latest step. Claude Code logs each in
// `<session>/subagents/`, with a `.meta.json` naming it and, for an `Agent` call, the call. That call
// ends with its result, or for a background call, a task notification. A workflow's agents are in
// its own directory: its journal records each agent's result, and a task notification the workflow's end.
// TaskStop ends a background agent or a workflow by its task id, which for an agent is its own id.
async function runningSubagents(path: string, main: LogState): Promise<Subagent[]> {
  const dir = join(path.slice(0, -".jsonl".length), "subagents");
  const files = (await readdir(dir, { recursive: true }).catch(() => [])).filter((name) => /agent-\w+\.jsonl$/.test(name));
  const subagents = [];
  for (const name of files) {
    const file = join(dir, name);
    const { mtimeMs } = await stat(file);
    if (Date.now() - mtimeMs > STALE_MS) continue;
    const meta = await readFile(file.replace(/\.jsonl$/, ".meta.json"), "utf8").then(JSON.parse, () => ({}));
    const id = basename(file, ".jsonl").slice("agent-".length);
    const done = meta.requestShape === "background" ? main.ended : main.results;
    if (meta.finished || main.ended.has(id) || (meta.toolUseId && done.has(meta.toolUseId))) continue;
    const workflow = dirname(file);
    if (main.workflows.get(workflow)?.some((end) => main.ended.has(end))) continue;
    if ((await journalResults(workflow)).has(id)) continue;
    const latest = (await readLog(file)).steps.at(-1);
    if (!firstSeen.has(file)) firstSeen.set(file, firstSeen.size);
    subagents.push({
      file,
      name: meta.description ?? "Subagent",
      text: latest?.text ?? "",
      at: latest?.at ?? new Date(mtimeMs).toISOString(),
    });
  }
  subagents.sort((a, b) => (firstSeen.get(a.file) ?? 0) - (firstSeen.get(b.file) ?? 0));
  return subagents.map(({ name, text, at }) => ({ name, text, at }));
}

// The ids of a workflow's agents that have returned; none outside a workflow.
async function journalResults(dir: string) {
  const journal = await readFile(join(dir, "journal.jsonl"), "utf8").catch(() => "");
  const ids = journal.split("\n").map((line) => (line ? JSON.parse(line) : {}));
  return new Set(ids.filter((entry) => entry.type === "result").map((entry) => entry.agentId));
}

const update = ({ text, at }: Update) => ({ text, at });

const recapFile = (path: string) => join(RECAP_DIR, `${basename(path, ".jsonl")}.json`);

// A session's recaps by the reply each follows. Before rounds, only the latest was saved.
async function savedRecaps(file: string): Promise<Record<string, Update>> {
  const saved = await readFile(file, "utf8").then(JSON.parse, () => ({}));
  return saved.replyId ? { [saved.replyId]: saved.recap } : saved;
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
  const file = recapFile(path);
  const [{ replyId }, saved] = await Promise.all([readLog(path), savedRecaps(file)]);
  if (replyId && saved[replyId]) return saved[replyId];
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
  await writeFile(file, JSON.stringify({ ...(await savedRecaps(file)), [replyId as string]: recap }));
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
  const log: LogState = logs.get(path) ?? {
    offset: 0,
    partial: "",
    rounds: [],
    steps: [],
    results: new Set(),
    ended: new Set(),
    workflows: new Map(),
    read: Promise.resolve(),
  };
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
      // A task notification arrives as a user message, or mid-turn as a queued command.
      const note = [typeof content === "string" ? content : "", entry.content, entry.attachment?.prompt].join("\n");
      for (const [, id] of note.matchAll(TASK_DONE)) log.ended.add(id);
      if (!Array.isArray(content)) continue;
      for (const block of content.filter((block) => block.type === "tool_result")) {
        log.results.add(block.tool_use_id);
        const result = JSON.stringify(block.content);
        const dir = /Transcript dir: ([^\s"\\]+)/.exec(result)?.[1];
        if (dir) log.workflows.set(dir, [block.tool_use_id, /Task ID: (\w+)/.exec(result)?.[1] ?? ""]);
        const stopped = /Successfully stopped task: (\w+)/.exec(result)?.[1];
        if (stopped) log.ended.add(stopped);
      }
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      // The user's prompts are text blocks; tool results, task notifications and injected context are not.
      if (entry.type === "user" && !entry.isMeta && content[0]?.type === "text") {
        if (log.request !== undefined) log.rounds.push({ steps: log.steps, replyId: log.replyId });
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
