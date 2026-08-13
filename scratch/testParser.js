const path = require('path');
const os = require('os');
const { LogParser } = require('../out/logParser.js');

const homeDir = os.homedir();
const mockSessionFile = path.join(homeDir, '.claude', 'projects', '-Users-mock-project', 'sessions', 'mock-session-1234.jsonl');

const parser = new LogParser();
const session = parser.parse(mockSessionFile, 'claude-code');

console.log('Parsed Session Result:');
console.log(JSON.stringify(session, null, 2));
