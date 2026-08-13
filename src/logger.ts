import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Write the debug log to the OS temp dir, not a hardcoded absolute path — the extension
// ships in the bundle and must not assume any particular machine or checkout location.
const LOG_FILE_PATH = path.join(os.tmpdir(), 'agentville-debug.log');

export function logDebug(message: string): void {
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE_PATH, `[${timestamp}] ${message}\n`);
  } catch {
    // Ignore logging errors to prevent secondary failures
  }
}
