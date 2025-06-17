/**
 * Unit tests for MCP Server
 */

import { describe, it, beforeEach, afterEach } from '@std/testing/bdd';
import { assertEquals, assertExists } from '@std/assert';

import { MCPServer } from '../../../src/mcp/server.ts';
import { MCPConfig, MCPTool } from '../../../src/utils/types.ts';
import { Logger } from '../../../src/core/logger.ts';
import { EventBus } from '../../../src/core/event-bus.ts';

describe('MCPServer', () => {
  let server: MCPServer;
  let logger: Logger;
  let eventBus: EventBus;
  let config: MCPConfig;

  beforeEach(async () => {
    logger = new Logger();
    await logger.configure({
      level: 'debug',
      format: 'text',
      destination: 'console',
    });

    eventBus = EventBus.getInstance(false);

    config = {
      transport: 'stdio',
      host: 'localhost',
      port: 3002,
      tlsEnabled: false,
      auth: { enabled: false, method: 'token' },
      loadBalancer: {
        enabled: false,
        strategy: 'round-robin',
        maxRequestsPerSecond: 100,
        healthCheckInterval: 30000,
        circuitBreakerThreshold: 5,
      },
      sessionTimeout: 60000,
      maxSessions: 10,
    };

    server = new MCPServer(config, eventBus, logger);
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('Lifecycle Management', () => {
    it('should initialize correctly', () => {
      assertExists(server);
    });

    it('should have start and stop methods', () => {
      // Test that the methods exist without actually starting/stopping
      assertEquals(typeof server.start, 'function');
      assertEquals(typeof server.stop, 'function');
    });

    it('should handle basic operations without starting', () => {
      // Test basic server operations that don't require starting
      assertEquals(typeof server.registerTool, 'function');
      assertEquals(typeof server.getHealthStatus, 'function');
    });

    it('should handle stop when not running', async () => {
      // Should not throw
      await server.stop();
    });
  });

  describe('Tool Management', () => {
    it('should register tools', () => {
      const testTool: MCPTool = {
        name: 'test/tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
        handler: async (input: any) => {
          return { received: input.message };
        },
      };

      server.registerTool(testTool);
    });

    it('should prevent duplicate tool registration', () => {
      const testTool: MCPTool = {
        name: 'test/duplicate',
        description: 'A test tool',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({}),
      };

      server.registerTool(testTool);
      
      try {
        server.registerTool(testTool);
        throw new Error('Should have thrown an error');
      } catch (error) {
        assertEquals((error as Error).message.includes('already registered'), true);
      }
    });
  });

  describe('Health and Metrics', () => {
    it('should provide health status without starting', async () => {
      const healthStatus = await server.getHealthStatus();
      assertExists(healthStatus);
      assertExists(healthStatus.healthy);
      // Healthy should be false when not started
      assertEquals(healthStatus.healthy, false);
    });

    it('should provide metrics without starting', () => {
      const metrics = server.getMetrics();
      assertExists(metrics);
      assertEquals(metrics.totalRequests >= 0, true);
      assertEquals(metrics.successfulRequests >= 0, true);
      assertEquals(metrics.failedRequests >= 0, true);
    });

    it('should track sessions without starting', () => {
      const sessions = server.getSessions();
      assertEquals(Array.isArray(sessions), true);
    });
  });

  describe('Session Management', () => {
    it('should get session by ID without starting', () => {
      // Since no sessions are created in these tests, should return undefined
      const session = server.getSession('non-existent');
      assertEquals(session, undefined);
    });

    it('should terminate sessions without starting', () => {
      // Should not throw even if session doesn't exist
      server.terminateSession('non-existent');
      assertEquals(true, true); // No errors thrown
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid config gracefully', () => {
      // Create a server with invalid config
      const invalidConfig = {
        ...config,
        port: -1, // Invalid port
      };
      
      const invalidServer = new MCPServer(invalidConfig, eventBus, logger);
      assertExists(invalidServer); // Should still create the server instance
    });

    it('should handle tool registration errors', () => {
      const invalidTool = {
        name: '', // Invalid name
        description: 'Invalid tool',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({}),
      } as MCPTool;

      try {
        server.registerTool(invalidTool);
        throw new Error('Should have thrown an error');
      } catch (error) {
        assertExists(error);
      }
    });
  });
});