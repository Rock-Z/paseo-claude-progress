import type { PluginServerContext } from "@getpaseo/plugin/server";
import { endTurn, getRecap, getSteps, startTurn, stopping } from "./server/claude";
import { recapRpc, stepsRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(stepsRpc, getSteps);
  server.handle(recapRpc, getRecap);
  const offStart = server.on("agent.turn_started", ({ agent }) => {
    if (agent.provider === "claude") startTurn(agent.id);
  });
  const offEnd = server.on("agent.turn_ended", ({ agent }, { paseo }) => {
    if (agent.provider === "claude") endTurn(paseo, agent.id);
  });
  return () => {
    offStart();
    offEnd();
    stopping.abort();
  };
}
