import type {
  PluginButtonBehavior,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { ProgressPanel, publish, QuietIcon, StepIcon } from "./client/pill";
import { DESCRIBED_TOOLS, type Round, recapRpc, stepsRpc, type Subagent, type Update } from "./shared/rpc";

// The popover reads each agent's progress from `publish`, so updating the pill never replaces this
// behavior, which would close an open popover.
const PANEL: PluginButtonBehavior = { kind: "popover", Content: ProgressPanel };
// Subagents work with no Paseo events to follow, so the plugin asks for their steps this often while
// Claude works or any subagent runs.
const SUBAGENT_POLL_MS = 3000;

interface Agent {
  id: string;
  workspaceId?: string | null;
  provider: string;
  status: string;
  pendingPermissions?: readonly unknown[];
}

interface Tracked {
  agent: Agent;
  workspaceId: string;
  steps: Update[];
  recap: Update | null;
  // The session's earlier rounds, oldest first.
  rounds: Round[];
  subagents: Subagent[];
  pill?: PluginButtonRegistration;
  stopWatching?: () => void;
  poll?: ReturnType<typeof setTimeout>;
}

export default function contribute(client: PluginClientContext) {
  const tracked = new Map<string, Tracked>();
  const lifetime = new AbortController();

  // While Claude works the pill shows its latest step; once it stops, the recap if there is one.
  const render = (entry: Tracked) => {
    // Paseo reports a turn waiting on a permission prompt as running; Claude isn't working then.
    const working = entry.agent.status === "running" && !entry.agent.pendingPermissions?.length;
    const { subagents } = entry;
    publish(entry.agent.id, { running: working, steps: entry.steps, recap: entry.recap, rounds: entry.rounds, subagents });
    if (!entry.poll && (working || subagents.length)) {
      entry.poll = setTimeout(() => {
        entry.poll = undefined;
        if (tracked.get(entry.agent.id) === entry) loadSteps(entry);
      }, SUBAGENT_POLL_MS);
    }
    // Once Claude stops, subagents still at work take the pill, newest step first, as Claude Code's spinner does.
    const newest = subagents.reduce<Subagent | undefined>((a, b) => (a && a.at > b.at ? a : b), undefined);
    const running = newest && `${subagents.length} ${subagents.length === 1 ? "Subagent" : "Subagents"}`;
    // Once a session has anything to show, the pill stays: a new turn shows "Working…" until its first
    // step, and a stopped turn without steps or a recap shows the last recap there is.
    const latest =
      (!working && newest ? `${running} · ${newest.text || newest.name}` : undefined) ??
      entry.recap?.text ??
      entry.steps.at(-1)?.text ??
      (working ? "Working…" : entry.rounds.findLast((round) => round.recap)?.recap?.text);
    if (!latest || !(entry.rounds.length || entry.steps.length || entry.recap || subagents.length)) {
      entry.pill?.update({ visible: false });
      return;
    }
    const button = {
      title: "Status and recaps",
      icon: working || newest ? StepIcon : QuietIcon,
      label: latest.replace(/\s+/g, " "),
      visible: true,
    };
    if (entry.pill) entry.pill.update(button);
    else {
      entry.pill = client.addComposerPill({
        id: "progress",
        workspaceId: entry.workspaceId,
        agentId: entry.agent.id,
        button: { ...button, behavior: PANEL },
      });
    }
  };

  const loadSteps = (entry: Tracked, callId?: string) =>
    client.rpc(stepsRpc, { agentId: entry.agent.id, callId }).then(
      ({ steps, subagents, rounds }) => {
        if (tracked.get(entry.agent.id) !== entry) return;
        entry.steps = steps;
        entry.subagents = subagents;
        if (rounds) entry.rounds = rounds;
        render(entry);
      },
      (error) => {
        console.error("Claude progress: steps failed", error);
        // Renders again only to keep polling.
        if (tracked.get(entry.agent.id) === entry) render(entry);
      },
    );

  // Claude Code shows each running call by the short description Claude gave it.
  const watchTurn = (entry: Tracked) => {
    const seen = new Set<string>();
    return client.paseo.agents.ref(entry.agent.id).timeline.subscribe(({ event }) => {
      if (event.type !== "timeline" || event.item.type !== "tool_call") return;
      const { callId, name } = event.item;
      if (!DESCRIBED_TOOLS.has(name) || seen.has(callId)) return;
      seen.add(callId);
      loadSteps(entry, callId);
    });
  };

  // Paseo times plugin calls out after 30 s; a recap queued behind others keeps going, so ask for it
  // again, for up to 5 minutes.
  const requestRecap = (entry: Tracked, saved: boolean, attempts = 10): Promise<void> =>
    client.rpc(recapRpc, { agentId: entry.agent.id, saved }).then(
      ({ recap }) => {
        if (!recap || tracked.get(entry.agent.id) !== entry || entry.agent.status !== "idle") return;
        entry.recap = recap;
        render(entry);
      },
      (error) =>
        attempts > 1
          ? requestRecap(entry, saved, attempts - 1)
          : console.error("Claude recap failed", error),
    );

  const upsert = (agent: Agent) => {
    if (agent.provider !== "claude" || !agent.workspaceId) return;
    const known = tracked.get(agent.id);
    const entry: Tracked = known ?? { agent, workspaceId: agent.workspaceId, steps: [], recap: null, rounds: [], subagents: [] };
    if (!known) {
      tracked.set(agent.id, entry);
      loadSteps(entry);
      if (agent.status === "idle") requestRecap(entry, true);
    }
    entry.agent = agent;
    const running = agent.status === "running";
    const turnChanged = running !== Boolean(entry.stopWatching);
    if (turnChanged) {
      entry.stopWatching?.();
      entry.stopWatching = running ? watchTurn(entry) : undefined;
      if (running && known) {
        if (entry.steps.length || entry.recap) {
          entry.rounds = [...entry.rounds, { steps: entry.steps, recap: entry.recap }];
        }
        entry.steps = [];
        entry.recap = null;
      }
    }
    // On every update: a permission prompt pauses Claude's work without ending the turn.
    render(entry);
    if (turnChanged && !running && known) {
      requestRecap(entry, false);
      // Also refreshes the earlier rounds, whose last recap may have finished after this turn began.
      loadSteps(entry);
    }
  };

  const drop = (agentId: string) => {
    const entry = tracked.get(agentId);
    entry?.stopWatching?.();
    clearTimeout(entry?.poll);
    entry?.pill?.remove();
    tracked.delete(agentId);
  };

  client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) =>
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const present = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of tracked.keys()) if (!present.has(agentId)) drop(agentId);
          for (const { agent } of entries) upsert(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          if (message.payload.kind === "remove") drop(message.payload.agentId);
          else upsert(message.payload.agent);
        },
      }),
    )
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("Claude progress: agent list failed", error);
    });

  return () => {
    lifetime.abort();
    for (const agentId of tracked.keys()) drop(agentId);
  };
}
