/**
 * JSON-based persistence layer for Claude-Flow
 */

import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";

export interface PersistedAgent {
  id: string;
  type: string;
  name: string;
  status: string;
  capabilities: string[];
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
  dependencies: string[];
  metadata: Record<string, unknown>;
  assignedAgent?: string;
  progress: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

interface PersistenceData {
  agents: PersistedAgent[];
  tasks: PersistedTask[];
  lastUpdated: number;
}

export class JsonPersistenceManager {
  private dataPath: string;
  private data: PersistenceData;

  constructor(dataDir: string = "./memory") {
    this.dataPath = join(dataDir, "claude-flow-data.json");
    this.data = {
      agents: [],
      tasks: [],
      lastUpdated: Date.now(),
    };
  }

  async initialize(): Promise<void> {
    // Ensure directory exists
    await ensureDir(join(this.dataPath, ".."));
    
    // Load existing data if available
    if (await exists(this.dataPath)) {
      try {
        const content = await Deno.readTextFile(this.dataPath);
        this.data = JSON.parse(content);
      } catch (error) {
        console.error("Failed to load persistence data:", error);
        // Keep default empty data
      }
    }
  }

  private async save(): Promise<void> {
    this.data.lastUpdated = Date.now();
    await Deno.writeTextFile(this.dataPath, JSON.stringify(this.data, null, 2));
  }

  // Agent operations
  async saveAgent(agent: PersistedAgent): Promise<void> {
    // Remove existing agent if updating
    this.data.agents = this.data.agents.filter(a => a.id !== agent.id);
    this.data.agents.push(agent);
    await this.save();
  }

  async getAgent(id: string): Promise<PersistedAgent | null> {
    return this.data.agents.find(a => a.id === id) || null;
  }

  async getActiveAgents(): Promise<PersistedAgent[]> {
    return this.data.agents.filter(a => a.status === 'active' || a.status === 'idle');
  }

  async getAllAgents(): Promise<PersistedAgent[]> {
    return this.data.agents;
  }

  async updateAgentStatus(id: string, status: string): Promise<void> {
    const agent = this.data.agents.find(a => a.id === id);
    if (agent) {
      agent.status = status;
      await this.save();
    }
  }

  // Task operations
  async saveTask(task: PersistedTask): Promise<void> {
    // Remove existing task if updating
    this.data.tasks = this.data.tasks.filter(t => t.id !== task.id);
    this.data.tasks.push(task);
    await this.save();
  }

  async getTask(id: string): Promise<PersistedTask | null> {
    return this.data.tasks.find(t => t.id === id) || null;
  }

  async getActiveTasks(): Promise<PersistedTask[]> {
    return this.data.tasks.filter(t => 
      t.status === 'pending' || 
      t.status === 'in_progress' || 
      t.status === 'assigned'
    );
  }

  async getAllTasks(): Promise<PersistedTask[]> {
    return this.data.tasks;
  }

  async updateTaskStatus(id: string, status: string, assignedAgent?: string): Promise<void> {
    const task = this.data.tasks.find(t => t.id === id);
    if (task) {
      task.status = status;
      if (assignedAgent !== undefined) {
        task.assignedAgent = assignedAgent;
      }
      if (status === 'completed') {
        task.completedAt = Date.now();
      }
      await this.save();
    }
  }

  async updateTaskProgress(id: string, progress: number): Promise<void> {
    const task = this.data.tasks.find(t => t.id === id);
    if (task) {
      task.progress = progress;
      await this.save();
    }
  }

  // Statistics
  async getStats(): Promise<{
    totalAgents: number;
    activeAgents: number;
    totalTasks: number;
    pendingTasks: number;
    completedTasks: number;
  }> {
    const activeAgents = this.data.agents.filter(a => 
      a.status === 'active' || a.status === 'idle'
    ).length;
    
    const pendingTasks = this.data.tasks.filter(t => 
      t.status === 'pending' || 
      t.status === 'in_progress' || 
      t.status === 'assigned'
    ).length;
    
    const completedTasks = this.data.tasks.filter(t => 
      t.status === 'completed'
    ).length;
    
    return {
      totalAgents: this.data.agents.length,
      activeAgents,
      totalTasks: this.data.tasks.length,
      pendingTasks,
      completedTasks,
    };
  }

  close(): void {
    // No-op for JSON persistence
  }
}