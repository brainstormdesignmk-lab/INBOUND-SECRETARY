import { Service } from '../fsm/machine';
import { AgentStore, AgentRow } from '../store/agents';

export function quotaKey(service: Service): 'sale' | 'rent' {
  return service === 'buy' ? 'sale' : 'rent';
}

/**
 * Assigns the visit to the least-loaded on-duty agent for that service type —
 * "all agents deserve an equal chance, in sale and rent".
 * Deterministic: min visits for the service this month, then min total, then lowest id.
 */
export class AgentDispatcher {
  constructor(private agents: AgentStore) {}

  pick(service: Service): AgentRow | null {
    const key = quotaKey(service);
    const candidates = this.agents
      .listActive()
      .filter(a => a.services.split(',').map(s => s.trim()).includes(key));
    if (!candidates.length) return null;
    const scored = candidates.map(a => ({
      agent: a,
      per: this.agents.visitsThisMonth(a.id, service),
      total: this.agents.totalVisitsThisMonth(a.id),
    }));
    scored.sort((x, y) => x.per - y.per || x.total - y.total || x.agent.id - y.agent.id);
    return scored[0].agent;
  }

  /** Called once the visit is actually confirmed (state = pending). */
  recordVisit(agentId: number, service: Service): void {
    this.agents.recordVisit(agentId, service);
  }
}
