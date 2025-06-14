# Claude Code Configuration - SPARC Development Environment

## Project Overview
This project uses the SPARC (Specification, Pseudocode, Architecture, Refinement, Completion) methodology for systematic Test-Driven Development with AI assistance through Claude-Flow orchestration.

## SPARC Development Commands

### Core SPARC Commands
- `npx claude-flow sparc modes`: List all available SPARC development modes
- `npx claude-flow sparc run <mode> "<task>"`: Execute specific SPARC mode for a task
- `npx claude-flow sparc tdd "<feature>"`: Run complete TDD workflow using SPARC methodology
- `npx claude-flow sparc info <mode>`: Get detailed information about a specific mode

### Standard Build Commands
- `npm run build`: Build the project
- `npm run test`: Run the test suite
- `npm run lint`: Run linter and format checks
- `npm run typecheck`: Run TypeScript type checking

## SPARC Methodology Workflow

### 1. Specification Phase
```bash
# Create detailed specifications and requirements
npx claude-flow sparc run spec-pseudocode "Define user authentication requirements"
```
- Define clear functional requirements
- Document edge cases and constraints
- Create user stories and acceptance criteria
- Establish non-functional requirements

### 2. Pseudocode Phase
```bash
# Develop algorithmic logic and data flows
npx claude-flow sparc run spec-pseudocode "Create authentication flow pseudocode"
```
- Break down complex logic into steps
- Define data structures and interfaces
- Plan error handling and edge cases
- Create modular, testable components

### 3. Architecture Phase
```bash
# Design system architecture and component structure
npx claude-flow sparc run architect "Design authentication service architecture"
```
- Create system diagrams and component relationships
- Define API contracts and interfaces
- Plan database schemas and data flows
- Establish security and scalability patterns

### 4. Refinement Phase (TDD Implementation)
```bash
# Execute Test-Driven Development cycle
npx claude-flow sparc tdd "implement user authentication system"
```

**TDD Cycle:**
1. **Red**: Write failing tests first
2. **Green**: Implement minimal code to pass tests
3. **Refactor**: Optimize and clean up code
4. **Repeat**: Continue until feature is complete

### 5. Completion Phase
```bash
# Integration, documentation, and validation
npx claude-flow sparc run integration "integrate authentication with user management"
```
- Integrate all components
- Perform end-to-end testing
- Create comprehensive documentation
- Validate against original requirements

## SPARC Mode Reference

### Development Modes
- **`architect`**: System design and architecture planning
- **`code`**: Clean, modular code implementation
- **`tdd`**: Test-driven development and testing
- **`spec-pseudocode`**: Requirements and algorithmic planning
- **`integration`**: System integration and coordination

### Quality Assurance Modes
- **`debug`**: Troubleshooting and bug resolution
- **`security-review`**: Security analysis and vulnerability assessment
- **`refinement-optimization-mode`**: Performance optimization and refactoring

### Support Modes
- **`docs-writer`**: Documentation creation and maintenance
- **`devops`**: Deployment and infrastructure management
- **`mcp`**: External service integration
- **`swarm`**: Multi-agent coordination for complex tasks

## Claude Code Slash Commands

Claude Code slash commands are available in `.claude/commands/`:

### Project Commands
- `/sparc`: Execute SPARC methodology workflows
- `/sparc-<mode>`: Run specific SPARC mode (e.g., /sparc-architect)
- `/claude-flow-help`: Show all Claude-Flow commands
- `/claude-flow-memory`: Interact with memory system
- `/claude-flow-swarm`: Coordinate multi-agent swarms

### Using Slash Commands
1. Type `/` in Claude Code to see available commands
2. Select a command or type its name
3. Commands are context-aware and project-specific
4. Custom commands can be added to `.claude/commands/`

## Code Style and Best Practices

### SPARC Development Principles
- **Modular Design**: Keep files under 500 lines, break into logical components
- **Environment Safety**: Never hardcode secrets or environment-specific values
- **Test-First**: Always write tests before implementation (Red-Green-Refactor)
- **Clean Architecture**: Separate concerns, use dependency injection
- **Documentation**: Maintain clear, up-to-date documentation

### Coding Standards
- Use TypeScript for type safety and better tooling
- Follow consistent naming conventions (camelCase for variables, PascalCase for classes)
- Implement proper error handling and logging
- Use async/await for asynchronous operations
- Prefer composition over inheritance

### Memory and State Management
- Use claude-flow memory system for persistent state across sessions
- Store progress and findings using namespaced keys
- Query previous work before starting new tasks
- Export/import memory for backup and sharing

## SPARC Memory Integration

### Memory Commands for SPARC Development
```bash
# Store project specifications
npx claude-flow memory store spec_auth "User authentication requirements and constraints"

# Store architectural decisions
npx claude-flow memory store arch_decisions "Database schema and API design choices"

# Store test results and coverage
npx claude-flow memory store test_coverage "Authentication module: 95% coverage, all tests passing"

# Query previous work
npx claude-flow memory query auth_implementation

# Export project memory
npx claude-flow memory export project_backup.json
```

### Memory Namespaces
- **`spec`**: Requirements and specifications
- **`arch`**: Architecture and design decisions
- **`impl`**: Implementation notes and code patterns
- **`test`**: Test results and coverage reports
- **`debug`**: Bug reports and resolution notes

## Workflow Examples

### Feature Development Workflow
```bash
# 1. Start with specification
npx claude-flow sparc run spec-pseudocode "User profile management feature"

# 2. Design architecture
npx claude-flow sparc run architect "Profile service architecture with data validation"

# 3. Implement with TDD
npx claude-flow sparc tdd "user profile CRUD operations"

# 4. Security review
npx claude-flow sparc run security-review "profile data access and validation"

# 5. Integration testing
npx claude-flow sparc run integration "profile service with authentication system"

# 6. Documentation
npx claude-flow sparc run docs-writer "profile service API documentation"
```

### Bug Fix Workflow
```bash
# 1. Debug and analyze
npx claude-flow sparc run debug "authentication token expiration issue"

# 2. Write regression tests
npx claude-flow sparc run tdd "token refresh mechanism tests"

# 3. Implement fix
npx claude-flow sparc run code "fix token refresh in authentication service"

# 4. Security review
npx claude-flow sparc run security-review "token handling security implications"
```

## Configuration Files

### Claude Code Integration
- **`.claude/commands/`**: Claude Code slash commands for all SPARC modes
- **`.claude/logs/`**: Conversation and session logs

### SPARC Configuration
- **`.roomodes`**: SPARC mode definitions and configurations (auto-generated)
- **`.roo/`**: SPARC templates and workflows (auto-generated)

### Claude-Flow Configuration
- **`memory/`**: Persistent memory and session data
- **`coordination/`**: Multi-agent coordination settings
- **`CLAUDE.md`**: Project instructions for Claude Code

## Git Workflow Integration

### Commit Strategy with SPARC
- **Specification commits**: After completing requirements analysis
- **Architecture commits**: After design phase completion
- **TDD commits**: After each Red-Green-Refactor cycle
- **Integration commits**: After successful component integration
- **Documentation commits**: After completing documentation updates

### Branch Strategy
- **`feature/sparc-<feature-name>`**: Feature development with SPARC methodology
- **`hotfix/sparc-<issue>`**: Bug fixes using SPARC debugging workflow
- **`refactor/sparc-<component>`**: Refactoring using optimization mode

### Commit Message Format
```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

### Types
- **feat**: New feature or functionality
- **fix**: Bug fix
- **docs**: Documentation only changes
- **style**: Code style changes (formatting, missing semicolons, etc.)
- **refactor**: Code change that neither fixes a bug nor adds a feature
- **perf**: Performance improvements
- **test**: Adding or updating tests
- **build**: Changes to build system or dependencies
- **ci**: Changes to CI configuration files and scripts
- **chore**: Other changes that don't modify src or test files
- **revert**: Reverts a previous commit

### Scope (optional but recommended)
The scope should indicate the area of the codebase affected:
- **cli**: CLI commands and interfaces
- **core**: Core orchestration and system components
- **memory**: Memory management and persistence
- **sparc**: SPARC methodology implementation
- **swarm**: Multi-agent coordination features
- **mcp**: Model Context Protocol integration
- **agent**: Agent management and spawning
- **task**: Task creation and management
- **workflow**: Workflow execution engine
- **monitor**: System monitoring and UI
- **config**: Configuration management
- **build**: Build system and tooling
- **deno**: Deno-specific configuration and deps

### Subject Rules
- Use imperative mood ("add" not "adds" or "added")
- Don't capitalize first letter
- No period at the end
- Maximum 50 characters
- Be specific and descriptive

### Body Guidelines
- Wrap at 72 characters
- Explain what and why vs. how
- Include context for the change
- Reference related issues or PRs
- Use bullet points for multiple changes

### Footer Format (when needed)
```
Fixes: #123
Refs: #456
Breaking: <description of breaking change>
```

### Examples

**Good Commits:**
```
feat(auth): add JWT token expiration handling

- Create useAuth hook for centralized auth state management
- Distinguish between expired and invalid tokens in middleware
- Add session expiration messages to login page
- Redirect to login with expiration flag

Fixes: #234
```

```
fix(teams): prevent duplicate team invitations

Check for existing pending invitations before creating new ones
to avoid database constraint violations and improve UX.
```

```
perf(analysis): batch transcript processing for large calls

Implement chunked processing for transcripts over 10K words to
reduce memory usage and improve analysis speed by 40%.
```

```
refactor(ui): extract call player controls to separate component

Move player controls logic from CallPage to dedicated component
for better reusability and testing isolation.
```

**Bad Commits (avoid these):**
```
Added new feature          # Not imperative mood
FEAT: New UI              # Don't use all caps
fix: fixed the bug.       # Redundant and has period
update code               # Too vague
feat: implement complete user authentication system with JWT # Too long
```

### Atomic Commits
- Each commit should represent ONE logical change
- If you need "and" in your commit message, consider splitting it
- All tests should pass after each commit
- The project should build successfully after each commit
- Don't mix refactoring with feature changes

### Commit Best Practices
1. **Review before committing**: Use `git diff --staged` to review changes
2. **Keep commits focused**: One concept per commit
3. **Write for future readers**: Clear messages help debugging
4. **Test before committing**: Run `pnpm test` and `pnpm typecheck`
5. **Don't commit generated files**: Build artifacts, node_modules, etc.
6. **Squash WIP commits**: Clean up history before merging

### Breaking Changes
If a commit introduces breaking changes, add in the footer:
```
feat(api): change call analysis response format

Restructure analysis response to include timestamps at item level
instead of top level for better component isolation.

Breaking: Analysis response structure changed, update frontend parsers
```

## Troubleshooting

### Common SPARC Issues
- **Mode not found**: Check `.roomodes` file exists and is valid JSON
- **Memory persistence**: Ensure `memory/` directory has write permissions
- **Tool access**: Verify required tools are available for the selected mode
- **Namespace conflicts**: Use unique memory namespaces for different features

### Debug Commands
```bash
# Check SPARC configuration
npx claude-flow sparc modes

# Verify memory system
npx claude-flow memory stats

# Check system status
npx claude-flow status

# View detailed mode information
npx claude-flow sparc info <mode-name>
```

## Project Architecture

This SPARC-enabled project follows a systematic development approach:
- **Clear separation of concerns** through modular design
- **Test-driven development** ensuring reliability and maintainability
- **Iterative refinement** for continuous improvement
- **Comprehensive documentation** for team collaboration
- **AI-assisted development** through specialized SPARC modes

## Important Notes

- Always run tests before committing (`npm run test`)
- Use SPARC memory system to maintain context across sessions
- Follow the Red-Green-Refactor cycle during TDD phases
- Document architectural decisions in memory for future reference
- Regular security reviews for any authentication or data handling code
- Claude Code slash commands provide quick access to SPARC modes

For more information about SPARC methodology, see: https://github.com/ruvnet/claude-code-flow/docs/sparc.md
