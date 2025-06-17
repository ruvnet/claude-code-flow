/**
 * Persistence layer for Claude-Flow using SQLite
 */

import { DB } from "@sqlite";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

export interface PersistedAgent {
  id: string;
  type: string;
  name: string;
  status: string;
  capabilities: string;
  systemPrompt: string;
  maxConcurrentTasks: number;
  priority: number;
  createdAt: number;
}

export interface PersistedTask {
  id: string;
  type: string;
  description: string;
  status: string;
  priority: number;
  dependencies: string;
  metadata: string;
  assignedAgent?: string;
  progress: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export class PersistenceManager {
  private db: DB;
  private dbPath: string;

  constructor(dataDir: string = "./memory") {
    this.dbPath = join(dataDir, "claude-flow.db");
  }

  async initialize(): Promise<void> {
    // Ensure directory exists
    await ensureDir(join(this.dbPath, ".."));
    
    // Open database
    this.db = new DB(this.dbPath);
    
    // Create tables if they don't exist
    this.createTables();
  }

  private createTables(): void {
    // Agents table
    this.db.execute(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        max_concurrent_tasks INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // Tasks table
    this.db.execute(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        dependencies TEXT NOT NULL,
        metadata TEXT NOT NULL,
        assigned_agent TEXT,
        progress INTEGER DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `);

    // Sessions table for terminal sessions
    this.db.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);
  }

  // Agent operations
  async saveAgent(agent: PersistedAgent): Promise<void> {
    this.db.query(
      `INSERT OR REPLACE INTO agents 
       (id, type, name, status, capabilities, system_prompt, max_concurrent_tasks, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agent.id,
        agent.type,
        agent.name,
        agent.status,
        agent.capabilities,
        agent.systemPrompt,
        agent.maxConcurrentTasks,
        agent.priority,
        agent.createdAt,
      ]
    );
  }

  async getAgent(id: string): Promise<PersistedAgent | null> {
    const rows = this.db.query<[string, string, string, string, string, string, number, number, number]>(
      "SELECT * FROM agents WHERE id = ?",
      [id]
    );
    
    if (rows.length === 0) return null;
    
    const [id_, type, name, status, capabilities, systemPrompt, maxConcurrentTasks, priority, createdAt] = rows[0];
    return {
      id: id_,
      type,
      name,
      status,
      capabilities,
      systemPrompt,
      maxConcurrentTasks,
      priority,
      createdAt,
    };
  }

  async getActiveAgents(): Promise<PersistedAgent[]> {
    const rows = this.db.query<[string, string, string, string, string, string, number, number, number]>(
      "SELECT * FROM agents WHERE status IN ('active', 'idle') ORDER BY created_at DESC"
    );
    
    return rows.map(([id, type, name, status, capabilities, systemPrompt, maxConcurrentTasks, priority, createdAt]) => ({
      id,
      type,
      name,
      status,
      capabilities,
      systemPrompt,
      maxConcurrentTasks,
      priority,
      createdAt,
    }));
  }

  async updateAgentStatus(id: string, status: string): Promise<void> {
    this.db.query("UPDATE agents SET status = ? WHERE id = ?", [status, id]);
  }

  // Task operations
  async saveTask(task: PersistedTask): Promise<void> {
    this.db.query(
      `INSERT OR REPLACE INTO tasks 
       (id, type, description, status, priority, dependencies, metadata, assigned_agent, progress, error, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.type,
        task.description,
        task.status,
        task.priority,
        task.dependencies,
        task.metadata,
        task.assignedAgent || null,
        task.progress,
        task.error || null,
        task.createdAt,
        task.completedAt || null,
      ]
    );
  }

  async getTask(id: string): Promise<PersistedTask | null> {
    const rows = this.db.query<[string, string, string, string, number, string, string, string | null, number, string | null, number, number | null]>(
      "SELECT * FROM tasks WHERE id = ?",
      [id]
    );
    
    if (rows.length === 0) return null;
    
    const [id_, type, description, status, priority, dependencies, metadata, assignedAgent, progress, error, createdAt, completedAt] = rows[0];
    return {
      id: id_,
      type,
      description,
      status,
      priority,
      dependencies,
      metadata,
      assignedAgent: assignedAgent || undefined,
      progress,
      error: error || undefined,
      createdAt,
      completedAt: completedAt || undefined,
    };
  }

  async getActiveTasks(): Promise<PersistedTask[]> {
    const rows = this.db.query<[string, string, string, string, number, string, string, string | null, number, string | null, number, number | null]>(
      "SELECT * FROM tasks WHERE status IN ('pending', 'in_progress', 'assigned') ORDER BY priority DESC, created_at ASC"
    );
    
    return rows.map(([id, type, description, status, priority, dependencies, metadata, assignedAgent, progress, error, createdAt, completedAt]) => ({
      id,
      type,
      description,
      status,
      priority,
      dependencies,
      metadata,
      assignedAgent: assignedAgent || undefined,
      progress,
      error: error || undefined,
      createdAt,
      completedAt: completedAt || undefined,
    }));
  }

  async updateTaskStatus(id: string, status: string, assignedAgent?: string): Promise<void> {
    if (assignedAgent) {
      this.db.query(
        "UPDATE tasks SET status = ?, assigned_agent = ? WHERE id = ?",
        [status, assignedAgent, id]
      );
    } else {
      this.db.query("UPDATE tasks SET status = ? WHERE id = ?", [status, id]);
    }
  }

  async updateTaskProgress(id: string, progress: number): Promise<void> {
    this.db.query("UPDATE tasks SET progress = ? WHERE id = ?", [progress, id]);
  }

  // Statistics
  async getStats(): Promise<{
    totalAgents: number;
    activeAgents: number;
    totalTasks: number;
    pendingTasks: number;
    completedTasks: number;
  }> {
    const [totalAgents] = this.db.query<[number]>("SELECT COUNT(*) FROM agents")[0];
    const [activeAgents] = this.db.query<[number]>("SELECT COUNT(*) FROM agents WHERE status IN ('active', 'idle')")[0];
    const [totalTasks] = this.db.query<[number]>("SELECT COUNT(*) FROM tasks")[0];
    const [pendingTasks] = this.db.query<[number]>("SELECT COUNT(*) FROM tasks WHERE status IN ('pending', 'in_progress', 'assigned')")[0];
    const [completedTasks] = this.db.query<[number]>("SELECT COUNT(*) FROM tasks WHERE status = 'completed'")[0];
    
    return {
      totalAgents,
      activeAgents,
      totalTasks,
      pendingTasks,
      completedTasks,
    };
  }

  close(): void {
    this.db.close();
  }
}