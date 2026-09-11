# Node 24 is Active LTS through April 2028. Keep this pinned to a
# supported LTS line; test-security-lock.js fails if it drifts to EOL.
FROM node:24-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

# Pre-install MCP backends for faster startup (avoids npx download on first call)
# Each installed separately so one failure doesn't block others
RUN npm install -g ruvector || true
RUN npm install -g ruflo || true
RUN npm install -g agentic-flow@alpha || true
RUN npm install -g gemini-mcp-server || true
RUN npm install -g @openai/codex || true

COPY index.js ./
COPY operations-tools.js ./
COPY mcp-stdio-kernel.js ./

# Create writable directories for MCP backends (ruflo, ruvector, agentic-flow)
# These tools write state/tasks/memory to the working directory at runtime
RUN mkdir -p /app/.claude-flow/tasks /app/.claude-flow/memory /app/.claude-flow/sessions \
    /app/.claude-flow/agents /app/.claude-flow/config /app/.claude-flow/data \
    /app/.claude-flow/logs /app/.claude-flow/swarm \
    && chown -R node:node /app/.claude-flow

USER node

EXPOSE 3001

ENV PORT=3001
# Default-on tool groups
ENV MCP_GROUP_INTELLIGENCE=true
ENV MCP_GROUP_AGENTS=true
ENV MCP_GROUP_MEMORY=true
ENV MCP_GROUP_DEVTOOLS=true
# Opt-in tool groups
ENV MCP_GROUP_SECURITY=false
ENV MCP_GROUP_BROWSER=false
ENV MCP_GROUP_NEURAL=false
ENV MCP_GROUP_AGENTIC_FLOW=false
ENV MCP_GROUP_CLAUDE_CODE=false
ENV MCP_GROUP_GEMINI=false
ENV MCP_GROUP_CODEX=false
ENV MCP_GROUP_OPERATIONS=false

CMD ["node", "index.js"]
