import { role as engineerRole } from "./engineer.js";
import { role as qaRole } from "./qa.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RoleConfig {
  name: string;
  displayName: string;
  systemPrompt: string;
  tools: any[];
  /** Linear issue filter for the poller */
  pollerFilter: {
    /** Only pick up issues with this label (undefined = no label check) */
    label?: string;
    /** Pick up issues in this workflow state name */
    stateName: string;
  };
  /** State to move issue to when work begins */
  inProgressState: string;
  /** State to move issue to when work is complete */
  doneState: string;
  /** Whether this role has the dev-agent subagent */
  hasDevAgent: boolean;
  /** Max turns for the agent session */
  maxTurns: number;
  /** Model to use for this role's main agent */
  model: string;
  /** Model to use for the dev-agent subagent (if hasDevAgent) */
  devAgentModel?: string;
}

const roles: Record<string, RoleConfig> = {
  engineer: engineerRole,
  qa: qaRole,
};

export function loadRole(): RoleConfig {
  const name = process.env.AGENT_ROLE ?? "engineer";
  const role = roles[name];
  if (!role) throw new Error(`Unknown AGENT_ROLE: ${name}`);
  return role;
}
