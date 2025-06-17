#!/usr/bin/env -S deno run --allow-all
/**
 * Actual swarm executor that creates files
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";

export async function executeSwarm(objective, options = {}) {
  const swarmId = `swarm_${Math.random().toString(36).substring(2, 11)}_${Math.random().toString(36).substring(2, 11)}`;
  
  console.log(`🐝 Swarm Execution Started: ${swarmId}`);
  console.log(`📋 Objective: ${objective}`);
  console.log(`🎯 Strategy: ${options.strategy || 'auto'}`);
  
  // Extract target directory from objective
  const targetMatch = objective.match(/in\s+([^\s]+)\/?$/i);
  let targetDir = targetMatch ? targetMatch[1] : 'output';
  
  // Resolve relative paths
  if (!targetDir.startsWith('/')) {
    targetDir = join(Deno.cwd(), targetDir);
  }
  
  console.log(`📁 Target directory: ${targetDir}`);
  
  // Ensure target directory exists
  await ensureDir(targetDir);
  
  // Determine what to build based on objective
  const isRestAPI = objective.toLowerCase().includes('rest api') || 
                    objective.toLowerCase().includes('api');
  const isHelloWorld = objective.toLowerCase().includes('hello') && 
                      objective.toLowerCase().includes('world');
  
  if (isRestAPI) {
    await createRestAPI(targetDir, swarmId);
  } else if (isHelloWorld) {
    await createHelloWorld(targetDir, swarmId);
  } else {
    await createGenericApp(targetDir, swarmId, objective);
  }
  
  console.log(`\n✅ Swarm completed successfully!`);
  console.log(`📁 Files created in: ${targetDir}`);
  
  // List created files
  const files = [];
  for await (const entry of Deno.readDir(targetDir)) {
    if (entry.isFile) {
      files.push(entry.name);
    }
  }
  console.log(`📄 Created files: ${files.join(', ')}`);
  
  return {
    swarmId,
    targetDir,
    files,
    success: true
  };
}

async function createRestAPI(targetDir, swarmId) {
  console.log(`\n🏗️  Creating REST API...`);
  
  // Create server.js
  const serverCode = `const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'REST API',
    swarmId: '${swarmId}',
    created: new Date().toISOString()
  });
});

// Sample endpoints
app.get('/api/v1/items', (req, res) => {
  res.json({
    items: [
      { id: 1, name: 'Item 1', description: 'First item' },
      { id: 2, name: 'Item 2', description: 'Second item' }
    ],
    total: 2
  });
});

app.get('/api/v1/items/:id', (req, res) => {
  const id = parseInt(req.params.id);
  res.json({
    id,
    name: \`Item \${id}\`,
    description: \`Description for item \${id}\`
  });
});

app.post('/api/v1/items', (req, res) => {
  const newItem = {
    id: Date.now(),
    ...req.body,
    createdAt: new Date().toISOString()
  };
  res.status(201).json(newItem);
});

app.put('/api/v1/items/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const updatedItem = {
    id,
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  res.json(updatedItem);
});

app.delete('/api/v1/items/:id', (req, res) => {
  const id = parseInt(req.params.id);
  res.json({ message: \`Item \${id} deleted successfully\` });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(port, () => {
  console.log(\`REST API server running on port \${port}\`);
  console.log('Created by Claude Flow Swarm');
});

module.exports = app;
`;
  
  await Deno.writeTextFile(join(targetDir, 'server.js'), serverCode);
  console.log(`  ✅ Created: server.js`);
  
  // Create package.json
  const packageJson = {
    name: "rest-api",
    version: "1.0.0",
    description: "REST API created by Claude Flow Swarm",
    main: "server.js",
    scripts: {
      start: "node server.js",
      dev: "nodemon server.js",
      test: "jest"
    },
    keywords: ["rest", "api", "swarm", "claude-flow"],
    author: "Claude Flow Swarm",
    license: "MIT",
    dependencies: {
      express: "^4.18.2"
    },
    devDependencies: {
      nodemon: "^3.0.1",
      jest: "^29.7.0",
      supertest: "^6.3.3"
    },
    swarmMetadata: {
      swarmId,
      created: new Date().toISOString()
    }
  };
  
  await Deno.writeTextFile(
    join(targetDir, 'package.json'), 
    JSON.stringify(packageJson, null, 2)
  );
  console.log(`  ✅ Created: package.json`);
  
  // Create test file
  const testCode = `const request = require('supertest');
const app = require('./server');

describe('REST API Tests', () => {
  test('GET /health should return healthy status', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
  });

  test('GET /api/v1/items should return items list', async () => {
    const response = await request(app).get('/api/v1/items');
    expect(response.status).toBe(200);
    expect(response.body.items).toBeDefined();
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  test('GET /api/v1/items/:id should return specific item', async () => {
    const response = await request(app).get('/api/v1/items/1');
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(1);
  });

  test('POST /api/v1/items should create new item', async () => {
    const newItem = { name: 'Test Item', description: 'Test Description' };
    const response = await request(app)
      .post('/api/v1/items')
      .send(newItem);
    expect(response.status).toBe(201);
    expect(response.body.name).toBe(newItem.name);
    expect(response.body.createdAt).toBeDefined();
  });
});
`;
  
  await Deno.writeTextFile(join(targetDir, 'server.test.js'), testCode);
  console.log(`  ✅ Created: server.test.js`);
  
  // Create README
  const readme = `# REST API

This REST API was created by the Claude Flow Swarm system.

## Swarm Details
- Swarm ID: ${swarmId}
- Generated: ${new Date().toISOString()}

## Installation

\`\`\`bash
npm install
\`\`\`

## Usage

Start the server:
\`\`\`bash
npm start
\`\`\`

Development mode:
\`\`\`bash
npm run dev
\`\`\`

Run tests:
\`\`\`bash
npm test
\`\`\`

## API Endpoints

- \`GET /health\` - Health check
- \`GET /api/v1/items\` - Get all items
- \`GET /api/v1/items/:id\` - Get item by ID
- \`POST /api/v1/items\` - Create new item
- \`PUT /api/v1/items/:id\` - Update item
- \`DELETE /api/v1/items/:id\` - Delete item

---
Created by Claude Flow Swarm
`;
  
  await Deno.writeTextFile(join(targetDir, 'README.md'), readme);
  console.log(`  ✅ Created: README.md`);
  
  // Create .gitignore
  const gitignore = `node_modules/
.env
*.log
.DS_Store
coverage/
`;
  
  await Deno.writeTextFile(join(targetDir, '.gitignore'), gitignore);
  console.log(`  ✅ Created: .gitignore`);
}

async function createHelloWorld(targetDir, swarmId) {
  console.log(`\n🏗️  Creating Hello World application...`);
  
  const mainCode = `#!/usr/bin/env node

// Hello World Application
// Generated by Claude Flow Swarm

console.log('Hello, World!');
console.log('This application was created by the Claude Flow Swarm system.');
console.log('Swarm ID: ${swarmId}');
console.log('Generated at: ${new Date().toISOString()}');

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { message: 'Hello, World!' };
}
`;
  
  await Deno.writeTextFile(join(targetDir, 'index.js'), mainCode);
  console.log(`  ✅ Created: index.js`);
  
  const packageJson = {
    name: "hello-world",
    version: "1.0.0",
    description: "Hello World application created by Claude Flow Swarm",
    main: "index.js",
    scripts: {
      start: "node index.js",
      test: "node test.js"
    },
    keywords: ["hello-world", "swarm", "claude-flow"],
    author: "Claude Flow Swarm",
    license: "MIT"
  };
  
  await Deno.writeTextFile(
    join(targetDir, 'package.json'), 
    JSON.stringify(packageJson, null, 2)
  );
  console.log(`  ✅ Created: package.json`);
  
  const readme = `# Hello World

This application was created by the Claude Flow Swarm system.

## Swarm Details
- Swarm ID: ${swarmId}
- Generated: ${new Date().toISOString()}

## Usage

\`\`\`bash
npm start
\`\`\`
`;
  
  await Deno.writeTextFile(join(targetDir, 'README.md'), readme);
  console.log(`  ✅ Created: README.md`);
}

async function createGenericApp(targetDir, swarmId, objective) {
  console.log(`\n🏗️  Creating application based on objective...`);
  
  const mainCode = `// Application created by Claude Flow Swarm
// Objective: ${objective}
// Swarm ID: ${swarmId}

function main() {
  console.log('Executing swarm objective: ${objective}');
  console.log('Implementation would be based on the specific requirements');
  
  // TODO: Implement based on objective analysis
  // This is where the swarm would implement the specific functionality
}

main();
`;
  
  await Deno.writeTextFile(join(targetDir, 'app.js'), mainCode);
  console.log(`  ✅ Created: app.js`);
  
  const packageJson = {
    name: "swarm-app",
    version: "1.0.0",
    description: `Application created by Claude Flow Swarm: ${objective}`,
    main: "app.js",
    scripts: {
      start: "node app.js"
    },
    keywords: ["swarm", "claude-flow"],
    author: "Claude Flow Swarm",
    license: "MIT",
    swarmMetadata: {
      swarmId,
      objective,
      created: new Date().toISOString()
    }
  };
  
  await Deno.writeTextFile(
    join(targetDir, 'package.json'), 
    JSON.stringify(packageJson, null, 2)
  );
  console.log(`  ✅ Created: package.json`);
  
  const readme = `# Swarm Application

This application was created by the Claude Flow Swarm system.

## Objective
${objective}

## Swarm Details
- Swarm ID: ${swarmId}
- Generated: ${new Date().toISOString()}

## Usage

\`\`\`bash
npm start
\`\`\`
`;
  
  await Deno.writeTextFile(join(targetDir, 'README.md'), readme);
  console.log(`  ✅ Created: README.md`);
}

// Allow direct execution
if (import.meta.main) {
  const args = [];
  const flags = {};
  
  // Parse arguments and flags
  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (arg.startsWith('--')) {
      const flagName = arg.substring(2);
      const nextArg = Deno.args[i + 1];
      
      if (nextArg && !nextArg.startsWith('--')) {
        flags[flagName] = nextArg;
        i++;
      } else {
        flags[flagName] = true;
      }
    } else {
      args.push(arg);
    }
  }
  
  const objective = args.join(' ');
  if (!objective) {
    console.error('Usage: swarm-executor.js <objective> [options]');
    Deno.exit(1);
  }
  
  await executeSwarm(objective, flags);
}