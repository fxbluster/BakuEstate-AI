const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { execSync } = require('child_process');

const BAKU_PROJECT_ID = 'b4a1e57a-7e05-4c00-8000-ba7e57a70001';
const BAKU_WORKSPACE_URIS = [
  'file:///C:/Users/HP/BakuEstate-AI',
  'file:///c:/Users/HP/BakuEstate-AI',
  'file:///c%3A/Users/HP/BakuEstate-AI',
  'file://C:/Users/HP/BakuEstate-AI'
];
const BAKU_WORKSPACE_URIS_JSON = JSON.stringify(BAKU_WORKSPACE_URIS);

const AGENTS = {
  '2c8a7a57-7940-40ac-95b5-940fcde3781e': '🏛️ CEO',
  '7e15e065-4287-468e-9ae1-d5dc8e12f68d': '🕵️‍♂️ Baş Müfəttiş',
  '436c215a-843e-4ce6-8098-fb3baddc1d64': '🕷️ Data Lead',
  'bb70499c-df52-4610-8c9e-b8382f2ec595': '🎙️ Copywriter Lead',
  '9fbf1b77-2eb3-4fc2-9f03-6abb3cdb8d18': '🎬 Media Lead',
  '13b031ee-1044-4d21-abc1-9f2a77aec951': '📱 Distribution Lead'
};

const LOGS_DIR = path.join(__dirname, '..', 'logs');
const PID_FILE = path.join(LOGS_DIR, 'baku_agent_keeper.pid');
const LOG_FILE = path.join(LOGS_DIR, 'baku_agent_keeper.log');

function log(msg) {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  const line = `[${new Date().toISOString()}] [BakuKeeper] ${msg}\n`;
  try { process.stdout.write(line); } catch (e) {}
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (e) {}
}

function sync() {
  const setupScript = path.join(__dirname, 'setup_baku_team.js');
  if (fs.existsSync(setupScript)) {
    try {
      execSync(`node "${setupScript}"`, { stdio: 'ignore' });
      log('BakuEstate squad synchronized successfully.');
    } catch (e) {
      log('Sync error: ' + e.message);
    }
  }
}

if (process.argv.includes('--daemon')) {
  log('Starting BakuKeeper daemon...');
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));

  sync();
  setInterval(sync, 60000); // Gentle 60s background sync

  process.on('SIGINT', () => { try { fs.unlinkSync(PID_FILE); } catch(e){} process.exit(0); });
  process.on('SIGTERM', () => { try { fs.unlinkSync(PID_FILE); } catch(e){} process.exit(0); });
} else {
  sync();
}
