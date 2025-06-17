/**
 * Comprehensive mock implementations for testing
 */

import { stub, spy } from "@std/testing/mock";
import type { Spy } from "@std/testing/mock";
import type { AgentProfile, Task } from "../../src/utils/types.ts";

// Since we can't import the actual interfaces yet, we'll define minimal interfaces
interface IEventBus {
  emit(event: string, data?: unknown): void;
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
  once(event: string, handler: (data: unknown) => void): void;
}

interface ILogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, error?: unknown): void;
  configure?(config: any): Promise<void>;
}

interface ITerminalManager {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  spawnTerminal(profile: any): Promise<string>;
  terminateTerminal(terminalId: string): Promise<void>;
  sendCommand(terminalId: string, command: any): Promise<string>;
}

interface IMemoryManager {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  createBank(agentId: string): Promise<string>;
  closeBank(bankId: string): Promise<void>;
  store(bankId: string, key: string, value: any): Promise<void>;
  retrieve(bankId: string, key: string): Promise<any>;
}

interface ICoordinationManager {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  assignTask(task: any, agentId: string): Promise<void>;
  getAgentTaskCount(agentId: string): Promise<number>;
  getAgentTasks(agentId: string): Promise<any[]>;
  cancelTask(taskId: string): Promise<void>;
}

interface IMCPServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  registerTool?(name: string, tool: any): void;
}

// Helper function to create spy
function createSpy<T extends (...args: any[]) => any>(implementation?: T): Spy<any, any> & T {
  const mockObj: Record<string, any> = {};
  const methodName = 'spyMethod';
  mockObj[methodName] = implementation || (() => {});
  return stub(mockObj, methodName as keyof typeof mockObj) as any;
}

/**
 * Mock EventBus implementation
 */
export class MockEventBus implements IEventBus {
  private events: Array<{ event: string; data: any }> = [];
  private handlers = new Map<string, Array<(data: any) => void>>();

  emit(event: string, data?: unknown): void {
    this.events.push({ event, data });
    const eventHandlers = this.handlers.get(event) || [];
    eventHandlers.forEach(handler => handler(data));
  }

  on(event: string, handler: (data: unknown) => void): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  off(event: string, handler: (data: unknown) => void): void {
    const eventHandlers = this.handlers.get(event) || [];
    const index = eventHandlers.indexOf(handler);
    if (index > -1) {
      eventHandlers.splice(index, 1);
    }
  }

  once(event: string, handler: (data: unknown) => void): void {
    const wrappedHandler = (data: unknown) => {
      handler(data);
      this.off(event, wrappedHandler);
    };
    this.on(event, wrappedHandler);
  }

  getEvents(): Array<{ event: string; data: any }> {
    return [...this.events];
  }

  clearEvents(): void {
    this.events = [];
  }

  clearHandlers(): void {
    this.handlers.clear();
  }
}

/**
 * Mock Logger implementation
 */
export class MockLogger implements ILogger {
  private logs: Array<{ level: string; message: string; data?: any }> = [];

  debug(message: string, data?: unknown): void {
    this.logs.push({ level: 'debug', message, data });
  }

  info(message: string, data?: unknown): void {
    this.logs.push({ level: 'info', message, data });
  }

  warn(message: string, data?: unknown): void {
    this.logs.push({ level: 'warn', message, data });
  }

  error(message: string, error?: unknown): void {
    this.logs.push({ level: 'error', message, data: error });
  }

  async configure(config: any): Promise<void> {
    // No-op for mock
  }

  getLogs(): Array<{ level: string; message: string; data?: any }> {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }

  hasLog(level: string, message: string): boolean {
    return this.logs.some(log => log.level === level && log.message.includes(message));
  }
}

/**
 * Mock Terminal Manager
 */
export class MockTerminalManager implements ITerminalManager {
  private terminals = new Map<string, { profile: AgentProfile; output: string[] }>();
  private initialized = false;
  
  spawnTerminal = createSpy(async (profile: any): Promise<string> => {
    const id = `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.terminals.set(id, { profile, output: [] });
    return id;
  });

  terminateTerminal = createSpy(async (terminalId: string): Promise<void> => {
    if (!this.terminals.has(terminalId)) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    this.terminals.delete(terminalId);
  });

  sendCommand = createSpy(async (terminalId: string, command: any): Promise<string> => {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Terminal not found: ${terminalId}`);
    
    const commandStr = typeof command === 'string' ? command : command.command || 'unknown';
    const output = `Mock output for: ${commandStr}`;
    terminal.output.push(output);
    return output;
  });

  initialize = createSpy(async (): Promise<void> => {
    if (this.initialized) {
      throw new Error('Terminal manager already initialized');
    }
    this.initialized = true;
  });

  shutdown = createSpy(async (): Promise<void> => {
    this.terminals.clear();
    this.initialized = false;
  });

  getHealthStatus = createSpy(async (): Promise<{ healthy: boolean; error?: string; metrics?: Record<string, number> }> => {
    return {
      healthy: this.initialized,
      metrics: {
        activeTerminals: this.terminals.size,
        totalCommands: Array.from(this.terminals.values()).reduce((sum, t) => sum + t.output.length, 0),
      },
    };
  });

  performMaintenance = createSpy(async (): Promise<void> => {
    // Simulate maintenance by clearing old terminals
    const now = Date.now();
    for (const [id, terminal] of this.terminals.entries()) {
      // Remove terminals older than 1 hour (for testing)
      const terminalAge = now - parseInt(id.split('-')[1]);
      if (terminalAge > 3600000) {
        this.terminals.delete(id);
      }
    }
  });

  getTerminal(id: string) {
    return this.terminals.get(id);
  }

  isInitialized() {
    return this.initialized;
  }
}

/**
 * Mock Memory Manager
 */
export class MockMemoryManager implements IMemoryManager {
  private banks = new Map<string, any[]>();
  private initialized = false;

  initialize = createSpy(async (): Promise<void> => {
    if (this.initialized) {
      throw new Error('Memory manager already initialized');
    }
    this.initialized = true;
  });

  shutdown = createSpy(async (): Promise<void> => {
    this.banks.clear();
    this.initialized = false;
  });

  createBank = createSpy(async (agentId: string): Promise<string> => {
    if (!agentId) {
      throw new Error('Agent ID is required');
    }
    const bankId = `bank-${agentId}-${Date.now()}`;
    this.banks.set(bankId, []);
    return bankId;
  });

  closeBank = createSpy(async (bankId: string): Promise<void> => {
    if (!this.banks.has(bankId)) {
      throw new Error(`Bank not found: ${bankId}`);
    }
    this.banks.delete(bankId);
  });

  store = createSpy(async (bankId: string, key: string, value: any): Promise<void> => {
    const bank = this.banks.get(bankId);
    if (!bank) throw new Error(`Bank not found: ${bankId}`);
    
    // Remove existing entry with same key
    const existingIndex = bank.findIndex(e => e.key === key);
    if (existingIndex >= 0) {
      bank.splice(existingIndex, 1);
    }
    
    bank.push({ 
      key, 
      value, 
      timestamp: Date.now(),
      size: JSON.stringify(value).length 
    });
  });

  retrieve = createSpy(async (bankId: string, key: string): Promise<any> => {
    const bank = this.banks.get(bankId);
    if (!bank) throw new Error(`Bank not found: ${bankId}`);
    const entry = bank.find(e => e.key === key);
    return entry?.value;
  });

  list = createSpy(async (bankId: string): Promise<string[]> => {
    const bank = this.banks.get(bankId);
    if (!bank) throw new Error(`Bank not found: ${bankId}`);
    return bank.map(e => e.key);
  });

  delete = createSpy(async (bankId: string, key: string): Promise<boolean> => {
    const bank = this.banks.get(bankId);
    if (!bank) throw new Error(`Bank not found: ${bankId}`);
    const index = bank.findIndex(e => e.key === key);
    if (index >= 0) {
      bank.splice(index, 1);
      return true;
    }
    return false;
  });

  getHealthStatus = createSpy(async (): Promise<{ healthy: boolean; error?: string; metrics?: Record<string, number> }> => {
    const totalEntries = Array.from(this.banks.values()).reduce((sum, bank) => sum + bank.length, 0);
    const totalSize = Array.from(this.banks.values())
      .flat()
      .reduce((sum, entry) => sum + (entry.size || 0), 0);

    return {
      healthy: this.initialized,
      metrics: {
        banks: this.banks.size,
        totalEntries,
        totalSize,
      },
    };
  });

  performMaintenance = createSpy(async (): Promise<void> => {
    // Simulate maintenance by cleaning up old entries
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    
    for (const bank of this.banks.values()) {
      for (let i = bank.length - 1; i >= 0; i--) {
        const entry = bank[i];
        if (entry.timestamp && (now - entry.timestamp) > maxAge) {
          bank.splice(i, 1);
        }
      }
    }
  });

  isInitialized() {
    return this.initialized;
  }
}

/**
 * Mock Coordination Manager
 */
export class MockCoordinationManager implements ICoordinationManager {
  private tasks = new Map<string, { task: Task; agentId: string }>();
  private agentTasks = new Map<string, Task[]>();
  private initialized = false;

  initialize = spy(async (): Promise<void> => {
    this.initialized = true;
  });

  shutdown = spy(async (): Promise<void> => {
    this.tasks.clear();
    this.agentTasks.clear();
    this.initialized = false;
  });

  assignTask = spy(async (task: Task, agentId: string): Promise<void> => {
    this.tasks.set(task.id, { task, agentId });
    const agentTaskList = this.agentTasks.get(agentId) || [];
    agentTaskList.push(task);
    this.agentTasks.set(agentId, agentTaskList);
  });

  getAgentTaskCount = spy(async (agentId: string): Promise<number> => {
    const tasks = this.agentTasks.get(agentId) || [];
    return tasks.filter(t => t.status !== 'completed' && t.status !== 'failed').length;
  });

  getAgentTasks = spy(async (agentId: string): Promise<Task[]> => {
    return this.agentTasks.get(agentId) || [];
  });

  cancelTask = spy(async (taskId: string): Promise<void> => {
    const taskInfo = this.tasks.get(taskId);
    if (taskInfo) {
      taskInfo.task.status = 'cancelled';
    }
  });

  getHealthStatus = spy(async (): Promise<{ healthy: boolean; error?: string; metrics?: Record<string, number> }> => {
    return {
      healthy: true,
      metrics: {
        totalTasks: this.tasks.size,
      },
    };
  });

  performMaintenance = spy(async (): Promise<void> => {
    // No-op for mock
  });

  isInitialized() {
    return this.initialized;
  }

  getTasks() {
    return new Map(this.tasks);
  }
}

/**
 * Mock MCP Server
 */
export class MockMCPServer implements IMCPServer {
  private started = false;
  private tools = new Map<string, any>();

  start = spy(async (): Promise<void> => {
    this.started = true;
  });

  stop = spy(async (): Promise<void> => {
    this.started = false;
    this.tools.clear();
  });

  registerTool = spy((name: string, tool: any): void => {
    this.tools.set(name, tool);
  });

  getHealthStatus = spy(async (): Promise<{ healthy: boolean; error?: string; metrics?: Record<string, number> }> => {
    return {
      healthy: this.started,
      metrics: {
        tools: this.tools.size,
      },
    };
  });

  isStarted() {
    return this.started;
  }

  getTools() {
    return new Map(this.tools);
  }
}

/**
 * Create a complete set of mocks for testing
 */
export function createMocks() {
  return {
    eventBus: new MockEventBus(),
    logger: new MockLogger(),
    terminalManager: new MockTerminalManager(),
    memoryManager: new MockMemoryManager(),
    coordinationManager: new MockCoordinationManager(),
    mcpServer: new MockMCPServer(),
  };
}

/**
 * Type guard for mock objects
 */
export function isMock(obj: any): boolean {
  return obj instanceof MockEventBus ||
         obj instanceof MockLogger ||
         obj instanceof MockTerminalManager ||
         obj instanceof MockMemoryManager ||
         obj instanceof MockCoordinationManager ||
         obj instanceof MockMCPServer;
}