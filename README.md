# 🌊 Claude-Flow v1.0.70: Advanced AI Agent Orchestration Platform

<div align="center">

[![🌟 Star on GitHub](https://img.shields.io/github/stars/ruvnet/claude-code-flow?style=for-the-badge&logo=github&color=gold)](https://github.com/ruvnet/claude-code-flow)
[![📦 NPX Ready](https://img.shields.io/npm/v/claude-flow?style=for-the-badge&logo=npm&color=blue&label=v1.0.70)](https://www.npmjs.com/package/claude-flow)
[![⚡ Claude Code](https://img.shields.io/badge/Claude%20Code-Ready-green?style=for-the-badge&logo=anthropic)](https://github.com/ruvnet/claude-code-flow)
[![🦕 Multi-Runtime](https://img.shields.io/badge/Runtime-Node%20%7C%20Deno-blue?style=for-the-badge&logo=javascript)](https://github.com/ruvnet/claude-code-flow)
[![⚡ TypeScript](https://img.shields.io/badge/TypeScript-Full%20Support-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![🛡️ MIT License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge&logo=opensourceinitiative)](https://opensource.org/licenses/MIT)

</div>

## 🎯 **Transform Your Development Workflow**

**Claude-Flow** is the ultimate orchestration platform that revolutionizes how you work with Claude Code. Coordinate **multiple AI agents** simultaneously, manage complex workflows, and build sophisticated applications with AI-powered development.

> 🔥 **One command to rule them all**: `npx claude-flow@latest init --sparc` - Deploy a full AI agent coordination system in seconds!

## 🚀 **What's New in v1.0.70**

### 🎯 **Critical Fix: SPARC File Initialization**

- **✅ Fixed SPARC Files**: `init --sparc` now properly copies all SPARC mode files to `.claude/commands/sparc/`
- **✅ Swarm Strategies**: Also copies swarm strategy files to `.claude/commands/swarm/`
- **✅ Config File**: Creates `.claude/config.json` with proper configuration
- **✅ Complete Setup**: All 18 SPARC modes and 7 swarm strategies now included
- **✅ Project-Focused**: Maintains v1.0.70's clear project-building focus

### 🔧 **Core Improvements**

- **✅ Memory System**: Functional in-memory storage with export/import
- **✅ Agent Management**: Added `info` and `terminate` commands
- **✅ MCP Status Detection**: Real-time server status checking
- **✅ UI Compatibility**: Graceful handling of terminal limitations
- **✅ Error Recovery**: Better handling of port conflicts and missing dependencies

### 🚀 **Developer Experience**

- **✅ Simplified Setup**: One command initialization with local wrapper
- **✅ Cross-Platform**: Windows, Mac, and Linux support
- **✅ No Dependencies**: Works with just Node.js 18+
- **✅ Backwards Compatible**: All existing commands preserved

---

## ⚡ **Quick Start**

### 🚀 **Instant Setup**

```bash
# Install and initialize with SPARC development environment
npx claude-flow@latest init --sparc

# Use the local wrapper (created by init)
./claude-flow start --ui --port 3000

# Run SPARC commands
./claude-flow sparc "build a REST API"
```

### 🎛️ **SPARC Development Modes** (17 Specialized Agents)

```bash
# List all available SPARC modes
./claude-flow sparc modes

# Run specific development workflows
./claude-flow sparc run coder "implement user authentication"
./claude-flow sparc run architect "design microservice architecture"
./claude-flow sparc tdd "create test suite for API"
```

---

## 🏢 **Enterprise Features**

### 💼 **Enterprise-Grade Management**

Claude-Flow v1.0.70 includes comprehensive enterprise features for production deployments:

- **🗂️ Project Management**: Complete lifecycle tracking, team collaboration, and resource planning
- **🚀 Deployment Automation**: Blue-green, canary, and rolling deployments with automated rollback
- **☁️ Cloud Infrastructure**: Multi-cloud management with cost optimization (AWS, GCP, Azure)
- **🔒 Security & Compliance**: Vulnerability scanning, compliance checking (SOC2, GDPR, HIPAA)
- **📊 Analytics & Insights**: Performance monitoring, predictive optimization, and business intelligence
- **📋 Audit & Compliance**: Enterprise-grade audit logging with cryptographic integrity

```bash
# Enterprise command examples
claude-flow project create "E-commerce Platform" --type web-app --priority high
claude-flow deploy create "v2.1.0" --environment production --strategy blue-green
claude-flow cloud optimize --environment production
claude-flow security scan "API Security Audit" ./api --type vulnerability
claude-flow analytics insights --timerange 7d
claude-flow audit report compliance --framework SOC2 --timerange 90d
```

> 📖 **[Complete Enterprise Documentation](./ENTERPRISE_FEATURES.md)** - Detailed feature guide with examples and configuration

---

## 🏗️ **Core Features**

### 🤖 **Multi-Agent Orchestration**

- **Parallel Execution**: Run up to 10 agents concurrently with BatchTool
- **Smart Coordination**: Intelligent task distribution and load balancing
- **Memory Sharing**: Persistent knowledge bank across all agents
- **Real-time Monitoring**: Live dashboard for agent status and progress

### 🧠 **SPARC Development Framework**

- **17 Specialized Modes**: Architect, Coder, TDD, Security, DevOps, and more
- **Workflow Orchestration**: Complete development lifecycle automation
- **Interactive & Non-interactive**: Flexible execution modes
- **Boomerang Pattern**: Iterative development with continuous refinement

### 📊 **Advanced Monitoring & Analytics**

- **System Health Dashboard**: Real-time metrics and performance tracking
- **Task Coordination**: Dependency management and conflict resolution
- **Terminal Pool Management**: Efficient resource utilization
- **Coverage Reports**: Comprehensive test and code coverage analysis

---

## 🛠️ **Installation & Setup**

### **Method 1: Quick Start with NPX (Recommended)**

```bash
# Initialize with full SPARC environment
npx claude-flow@latest init --sparc

# This creates:
# ✓ Local ./claude-flow wrapper script
# ✓ .claude/ directory with configuration
# ✓ CLAUDE.md (project instructions for Claude Code)
# ✓ .roomodes (17 pre-configured SPARC modes)
# ✓ Swarm command documentation

# Start using immediately
./claude-flow start --ui --port 3000
```

### **Method 2: Global Installation**

```bash
# Install globally
npm install -g claude-flow

# Initialize anywhere
claude-flow init --sparc

# Use directly
claude-flow start --ui
```

### **Method 3: Local Project Installation**

```bash
# Add to project
npm install claude-flow --save-dev

# Initialize
npx claude-flow init --sparc

# Use with local wrapper
./claude-flow start --ui
```

---

## 🎮 **Usage Examples**

### 🚀 **Basic Operations**

```bash
# Check system status
./claude-flow status

# Start orchestration with Web UI
./claude-flow start --ui --port 3000

# Check MCP server status
./claude-flow mcp status

# Manage agents
./claude-flow agent spawn researcher --name "DataBot"
./claude-flow agent info agent-123
./claude-flow agent terminate agent-123
```

### 🔥 **Advanced Workflows**

#### **Multi-Agent Development**

```bash
# Deploy swarm for full-stack development
./claude-flow swarm "Build e-commerce platform" \
  --strategy development \
  --max-agents 5 \
  --parallel \
  --monitor

# BatchTool parallel development
batchtool run --parallel \
  "./claude-flow sparc run architect 'design user auth'" \
  "./claude-flow sparc run code 'implement login API'" \
  "./claude-flow sparc run tdd 'create auth tests'" \
  "./claude-flow sparc run security-review 'audit auth flow'"
```

#### **SPARC Development Modes**

```bash
# Complete development workflow
./claude-flow sparc run ask "research best practices for microservices"
./claude-flow sparc run architect "design scalable architecture"
./claude-flow sparc run code "implement user service"
./claude-flow sparc run tdd "create comprehensive test suite"
./claude-flow sparc run integration "integrate all services"
./claude-flow sparc run devops "setup CI/CD pipeline"
```

#### **Memory & Coordination**

```bash
# Store and query project knowledge
./claude-flow memory store requirements "User auth with JWT"
./claude-flow memory store architecture "Microservice design patterns"
./claude-flow memory query auth

# Task coordination
./claude-flow task create research "Market analysis for AI tools"
./claude-flow task workflow examples/development-pipeline.json
```

---

## 📋 **Available Commands**

### **Core Commands**

| Command  | Description                                | Example                                      |
| -------- | ------------------------------------------ | -------------------------------------------- |
| `init`   | Initialize project with Claude integration | `./claude-flow init --sparc`                 |
| `start`  | Start orchestration system                 | `./claude-flow start --ui`                   |
| `status` | Show system health and metrics             | `./claude-flow status`                       |
| `agent`  | Manage AI agents and hierarchies           | `./claude-flow agent spawn researcher`       |
| `swarm`  | Advanced multi-agent coordination          | `./claude-flow swarm "Build API" --parallel` |

### **SPARC Development Modes**

| Mode              | Purpose                             | Example                                               |
| ----------------- | ----------------------------------- | ----------------------------------------------------- |
| `architect`       | System design and architecture      | `./claude-flow sparc run architect "design API"`      |
| `code`            | Code development and implementation | `./claude-flow sparc run code "user authentication"`  |
| `tdd`             | Test-driven development             | `./claude-flow sparc run tdd "payment system"`        |
| `security-review` | Security auditing and analysis      | `./claude-flow sparc run security-review "auth flow"` |
| `integration`     | System integration and testing      | `./claude-flow sparc run integration "microservices"` |
| `devops`          | Deployment and CI/CD                | `./claude-flow sparc run devops "k8s deployment"`     |

### **Memory & Coordination**

| Command        | Description                         | Example                                          |
| -------------- | ----------------------------------- | ------------------------------------------------ |
| `memory store` | Store information in knowledge bank | `./claude-flow memory store key "value"`         |
| `memory query` | Search stored information           | `./claude-flow memory query "authentication"`    |
| `task create`  | Create and manage tasks             | `./claude-flow task create research "AI trends"` |
| `monitor`      | Real-time system monitoring         | `./claude-flow monitor --dashboard`              |

### **Enterprise Commands**

| Command     | Description                           | Example                                                      |
| ----------- | ------------------------------------- | ------------------------------------------------------------ |
| `project`   | Project lifecycle management          | `./claude-flow project create "API Project" --type web-app`  |
| `deploy`    | Deployment automation & strategies    | `./claude-flow deploy create "v1.2.0" --strategy blue-green` |
| `cloud`     | Multi-cloud infrastructure management | `./claude-flow cloud resources create "web-server" compute`  |
| `security`  | Security scanning & compliance        | `./claude-flow security scan "Vulnerability Check" ./src`    |
| `analytics` | Performance analytics & insights      | `./claude-flow analytics insights --timerange 7d`            |
| `audit`     | Enterprise audit logging              | `./claude-flow audit report compliance --framework SOC2`     |

---

## 🏗️ **Architecture Overview**

### **Multi-Layer Agent System**

```
┌─────────────────────────────────────────────────────────┐
│                 BatchTool Orchestrator                  │
├─────────────────────────────────────────────────────────┤
│  Agent 1    Agent 2    Agent 3    Agent 4    Agent 5   │
│ Architect │   Coder   │   TDD    │ Security │  DevOps   │
├─────────────────────────────────────────────────────────┤
│              Shared Memory Bank & Coordination          │
├─────────────────────────────────────────────────────────┤
│         Terminal Pool & Resource Management             │
├─────────────────────────────────────────────────────────┤
│              Claude Code Integration Layer              │
└─────────────────────────────────────────────────────────┘
```

### **Key Components**

- **🎛️ Orchestrator**: Central coordination and task distribution
- **🤖 Agent Pool**: Specialized AI agents for different domains
- **🧠 Memory Bank**: Persistent knowledge sharing across agents
- **📊 Monitor**: Real-time metrics and health monitoring
- **🔗 MCP Server**: Model Context Protocol for tool integration

---

## 🧪 **Testing & Quality Assurance**

### **Comprehensive Test Coverage**

```bash
# Run full test suite
npm test

# Run specific test categories
npm run test:unit        # Unit tests
npm run test:integration # Integration tests
npm run test:e2e         # End-to-end tests

# Generate coverage reports
npm run test:coverage

# Lint and typecheck
npm run lint
npm run typecheck
```

### **Quality Metrics (v1.0.70)**

- **✅ Project-Focused**: CLAUDE.md explicitly guides building user applications
- **✅ Clear Instructions**: No confusion about modifying claude-flow itself
- **✅ Real Examples**: All documentation shows building actual applications
- **✅ NPM Publishing**: Fully compatible with npx and global installation
- **✅ Cross-Platform**: Windows, Mac, and Linux support

---

## 📚 **Documentation & Resources**

### **Getting Started**

- [🚀 Quick Start Guide](./docs/quick-start.md)
- [⚙️ Configuration Options](./docs/configuration.md)
- [🤖 Agent Management](./docs/agents.md)
- [🧠 SPARC Development](./docs/sparc-modes.md)

### **Advanced Topics**

- [🔧 BatchTool Integration](./docs/batchtool.md)
- [📊 Monitoring & Analytics](./docs/monitoring.md)
- [🔗 MCP Server Setup](./docs/mcp-integration.md)
- [🔒 Security Best Practices](./docs/security.md)

### **API Reference**

- [📖 Command Reference](./docs/commands.md)
- [🎛️ Configuration Schema](./docs/config-schema.md)
- [🔌 Plugin Development](./docs/plugins.md)
- [🛠️ Troubleshooting](./docs/troubleshooting.md)

---

## 🤝 **Contributing**

We welcome contributions! Here's how to get started:

### **Prerequisites**

- Deno 1.40+ (Install: https://deno.land/#installation)
- Node.js 16+ (for npm wrapper)
- Git
- mise (optional, for development tool management)

### **Development Environment Setup**

#### **Using mise (Recommended)**

[mise](https://mise.jdx.dev/) is a polyglot tool version manager that ensures consistent development environments. This project includes a `mise.toml` configuration file.

```bash
# Install mise (if not already installed)
curl https://mise.jdx.dev/install.sh | sh

# Clone the repository
git clone https://github.com/ruvnet/claude-code-flow.git
cd claude-code-flow

# Install configured tools (Deno and Node.js)
mise install

# Verify installation
./bin/claude-flow --version
```

#### **Manual Setup**

```bash
# Clone the repository
git clone https://github.com/ruvnet/claude-code-flow.git
cd claude-code-flow

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Link for local development
npm link
```

### **Contributing Guidelines**

- 🐛 **Bug Reports**: Use GitHub issues with detailed reproduction steps
- 💡 **Feature Requests**: Propose new features with use cases
- 🔧 **Pull Requests**: Follow our coding standards and include tests
- 📚 **Documentation**: Help improve docs and examples

---

## 📄 **License**

MIT License - see [LICENSE](./LICENSE) for details.

---

## 🎉 **Acknowledgments**

- **Anthropic**: For the amazing Claude AI that powers this platform
- **Node.js Team**: For the excellent JavaScript runtime
- **Open Source Community**: For contributions and feedback
- **SPARC Methodology**: For the structured development approach

---

<div align="center">

### **🚀 Ready to transform your development workflow?**

```bash
npx claude-flow@latest init --sparc
```

**Join thousands of developers already using Claude-Flow!**

[![GitHub](https://img.shields.io/badge/GitHub-ruvnet/claude--code--flow-blue?style=for-the-badge&logo=github)](https://github.com/ruvnet/claude-code-flow)
[![NPM](https://img.shields.io/badge/NPM-claude--flow-red?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/claude-flow)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-purple?style=for-the-badge&logo=discord)](https://discord.gg/claude-flow)

---

**Built with ❤️ by [rUv](https://github.com/ruvnet) | Powered by Claude AI**

</div>

