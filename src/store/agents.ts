import { Db } from './db';
import { Service } from '../fsm/machine';

export interface AgentRow {
  id: number;
  name: string;
  phone: string;
  services: string; // 'sale,rent'
  onDuty: number;   // 0 | 1
}

export class AgentStore {
  constructor(private db: Db) {}

  /** Phase 1: one agent (your real number). Many agents later. */
  ensureDefault(phone: string): void {
    const count = (this.db.db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number }).c;
    if (count === 0) {
      this.db.db.prepare(
        `INSERT INTO agents (name, phone, services, on_duty) VALUES (?, ?, 'sale,rent', 1)`
      ).run('Агент 1 (default)', phone);
    }
  }

  listActive(): AgentRow[] {
    return this.db.db.prepare(
      `SELECT id, name, phone, services, on_duty as onDuty
       FROM agents WHERE on_duty = 1 ORDER BY id`
    ).all() as AgentRow[];
  }

  get(id: number): AgentRow | undefined {
    return this.db.db.prepare(
      `SELECT id, name, phone, services, on_duty as onDuty FROM agents WHERE id = ?`
    ).get(id) as AgentRow | undefined;
  }

  visitsThisMonth(agentId: number, service: Service): number {
    const month = new Date().toISOString().slice(0, 7);
    const row = this.db.db.prepare(
      `SELECT count FROM agent_visits WHERE agent_id = ? AND service = ? AND month = ?`
    ).get(agentId, service === 'buy' ? 'sale' : 'rent', month) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  totalVisitsThisMonth(agentId: number): number {
    const month = new Date().toISOString().slice(0, 7);
    const row = this.db.db.prepare(
      `SELECT COALESCE(SUM(count), 0) as c FROM agent_visits WHERE agent_id = ? AND month = ?`
    ).get(agentId, month) as { c: number };
    return row.c;
  }

  recordVisit(agentId: number, service: Service): void {
    const month = new Date().toISOString().slice(0, 7);
    this.db.db.prepare(
      `INSERT INTO agent_visits (agent_id, service, month, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(agent_id, service, month) DO UPDATE SET count = count + 1`
    ).run(agentId, service === 'buy' ? 'sale' : 'rent', month);
  }
}
