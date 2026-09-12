/**
 * MCPServer
 *
 * Model Context Protocol server for V3.
 * Provides MCP-first API design per ADR-005.
 */

import type {
  MCPServerOptions,
  MCPTool,
  MCPToolProvider,
  MCPRequest,
  MCPResponse
} from '../../shared/types';

export class MCPServer {
  private tools: MCPToolProvider[];
  private port: number;
  private host: string;
  private running: boolean = false;
  private toolRegistry: Map<string, MCPTool>;

  try {
      this.server.connect(this.transport).catch((error) => {
        console.error("MCP Transport runtime connection error:", error);
      });
      
      if (this.transport) {
        this.transport.onclose = () => {
          console.log("MCP Client connection dropped cleanly.");
        };
      }
    } catch (error) {
      console.error("Critical failure during MCP connection setup:", error);
    }
    // Build tool registry
    for (const provider of this.tools) {
      if (provider.getTools) {
        for (const tool of provider.getTools()) {
          this.toolRegistry.set(tool.name, tool);
        }
      }
    }

    this.running = true;
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    this.running = false;
    this.toolRegistry.clear();
  }

  /**
   * Register a tool
   */
  registerTool(tool: MCPTool): void {
    this.toolRegistry.set(tool.name, tool);
  }

  /**
   * List all available tools
   */
  listTools(): MCPTool[] {
    return Array.from(this.toolRegistry.values());
  }

  /**
   * Handle an MCP request
   */
  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    try {
      // Find the tool provider that can handle this request
      for (const provider of this.tools) {
        try {
          const result = await provider.execute(request.method, request.params);
          return {
            id: request.id,
            result
          };
        } catch (error) {
          // Tool provider doesn't handle this method, try next
          continue;
        }
      }

      return {
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`
        }
      };
    } catch (error) {
      return {
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error'
        }
      };
    }
  }

  /**
   * Get server status
   */
  getStatus(): { running: boolean; port: number; host: string; toolCount: number } {
    return {
      running: this.running,
      port: this.port,
      host: this.host,
      toolCount: this.toolRegistry.size
    };
  }
}

export { MCPServer as default };
