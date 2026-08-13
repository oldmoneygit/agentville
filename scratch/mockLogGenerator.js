const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();
const mockProjectDir = path.join(homeDir, '.claude', 'projects', '-Users-mock-project');
const mockSessionDir = path.join(mockProjectDir, 'sessions');
const mockSessionFile = path.join(mockSessionDir, 'mock-session-1234.jsonl');

// Ensure directories exist
fs.mkdirSync(mockSessionDir, { recursive: true });

console.log(`Writing mock session log to: ${mockSessionFile}`);

// Clear previous content
fs.writeFileSync(mockSessionFile, '');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  // 1. Initial user request and git branch
  const turn1 = {
    timestamp: new Date().toISOString(),
    gitBranch: 'feature/mock-auth',
    role: 'user',
    message: {
      content: [
        { type: 'text', text: 'Create a secure OAuth login flow' }
      ]
    }
  };
  fs.appendFileSync(mockSessionFile, JSON.stringify(turn1) + '\n');
  console.log('Turn 1: Appended initial prompt and git branch.');
  await sleep(3000);

  // 2. Spawn a subagent
  const subagentStart = {
    timestamp: new Date().toISOString(),
    gitBranch: 'feature/mock-auth',
    type: 'tool_use',
    name: 'Agent',
    id: 'toolu_mock_subagent_1',
    input: {
      name: 'Security Specialist',
      task: 'Review OAuth redirect URI vulnerabilities'
    }
  };
  fs.appendFileSync(mockSessionFile, JSON.stringify(subagentStart) + '\n');
  console.log('Turn 2: Subagent spawned (working).');
  await sleep(5000);

  // 3. Resolve the subagent
  const subagentEnd = {
    timestamp: new Date().toISOString(),
    gitBranch: 'feature/mock-auth',
    type: 'tool_result',
    tool_use_id: 'toolu_mock_subagent_1',
    content: 'All redirect URIs must be strictly validated against a whitelist.'
  };
  fs.appendFileSync(mockSessionFile, JSON.stringify(subagentEnd) + '\n');
  console.log('Turn 3: Subagent completed task.');
}

run().catch(console.error);
