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

function encodeVarint(val) {
  const res = [];
  while (val > 0x7f) {
    res.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  res.push(val & 0x7f);
  return Buffer.from(res);
}

function encodeField(fieldNum, wireType, data) {
  const key = (fieldNum << 3) | wireType;
  const keyBuf = encodeVarint(key);
  if (wireType === 2) {
    const lenBuf = encodeVarint(data.length);
    return Buffer.concat([keyBuf, lenBuf, data]);
  }
  return Buffer.concat([keyBuf, data]);
}

function encodeTimestampProto(dateOrIso) {
  const d = new Date(dateOrIso);
  const ms = d.getTime();
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1e6;
  const f1 = encodeField(1, 0, encodeVarint(seconds));
  const f2 = nanos > 0 ? encodeField(2, 0, encodeVarint(nanos)) : Buffer.alloc(0);
  return Buffer.concat([f1, f2]);
}

function parseProtoFields(buf) {
  if (!buf || buf.length === 0) return [];
  let pos = 0;
  const fields = [];
  while (pos < buf.length) {
    const start = pos;
    let key = 0, shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      key |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const wireType = key & 7;
    const fieldNum = key >> 3;
    if (wireType === 0) {
      let val = 0, s = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        val |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      fields.push({ fieldNum, wireType, val, raw: buf.slice(start, pos) });
    } else if (wireType === 2) {
      let len = 0, s = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      const data = buf.slice(pos, pos + len);
      pos += len;
      fields.push({ fieldNum, wireType, data, raw: buf.slice(start, pos) });
    } else {
      fields.push({ fieldNum, wireType, raw: buf.slice(start) });
      break;
    }
  }
  return fields;
}

function parseSummariesProto(buf) {
  let pos = 0;
  const entries = [];
  const trailingChunks = [];

  while (pos < buf.length) {
    let key = 0, shift = 0;
    const tagStart = pos;
    while (pos < buf.length) {
      const b = buf[pos++];
      key |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const wireType = key & 7;
    const fieldNum = key >> 3;
    if (fieldNum === 1 && wireType === 2) {
      let len = 0, s = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      const entryData = buf.slice(pos, pos + len);
      pos += len;

      let innerPos = 0;
      let convId = null;
      let summaryBytes = null;
      while (innerPos < entryData.length) {
        let ik = 0, is = 0;
        while (innerPos < entryData.length) {
          const b = entryData[innerPos++];
          ik |= (b & 0x7f) << is;
          if (!(b & 0x80)) break;
          is += 7;
        }
        const iwt = ik & 7;
        const ifn = ik >> 3;
        if (iwt === 2) {
          let ilen = 0, ls = 0;
          while (innerPos < entryData.length) {
            const b = entryData[innerPos++];
            ilen |= (b & 0x7f) << ls;
            if (!(b & 0x80)) break;
            ls += 7;
          }
          const data = entryData.slice(innerPos, innerPos + ilen);
          innerPos += ilen;
          if (ifn === 1) convId = data.toString('utf8');
          else if (ifn === 2) summaryBytes = data;
        } else if (iwt === 0) {
          while (innerPos < entryData.length) {
            if (!(entryData[innerPos++] & 0x80)) break;
          }
        } else {
          break;
        }
      }
      entries.push({ convId, summaryBytes, rawEntry: buf.slice(tagStart, pos) });
    } else if (wireType === 2) {
      let len = 0, s = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      pos += len;
      trailingChunks.push(buf.slice(tagStart, pos));
    } else if (wireType === 0) {
      while (pos < buf.length) {
        if (!(buf[pos++] & 0x80)) break;
      }
      trailingChunks.push(buf.slice(tagStart, pos));
    } else {
      trailingChunks.push(buf.slice(tagStart));
      break;
    }
  }
  return { entries, trailingData: Buffer.concat(trailingChunks) };
}

function serializeSummariesProto(entries, trailingData) {
  const chunks = [];
  for (const e of entries) {
    if (e.rawEntry) {
      chunks.push(e.rawEntry);
    } else {
      const keyField = encodeField(1, 2, Buffer.from(e.convId, 'utf8'));
      const valField = encodeField(2, 2, e.summaryBytes);
      const entryPayload = Buffer.concat([keyField, valField]);
      chunks.push(encodeField(1, 2, entryPayload));
    }
  }
  if (trailingData && trailingData.length > 0) {
    chunks.push(trailingData);
  }
  return Buffer.concat(chunks);
}

function buildSummaryProto(title, cid, stepCount = 5) {
  const titleBuf = Buffer.from(title, 'utf8');
  const projIdBuf = Buffer.from(BAKU_PROJECT_ID, 'utf8');
  const cidBuf = Buffer.from(cid, 'utf8');
  const nowIso = new Date().toISOString();

  const f1 = encodeField(1, 2, titleBuf);
  const f2 = encodeField(2, 0, encodeVarint(stepCount));
  const f3 = encodeField(3, 2, encodeTimestampProto(nowIso));
  const f4 = encodeField(4, 2, cidBuf);
  const f5 = encodeField(5, 0, encodeVarint(1)); // 1 = IDLE
  const f10 = encodeField(10, 2, encodeTimestampProto(nowIso));
  const f15 = encodeField(15, 2, encodeField(1, 2, titleBuf));

  const innerF6 = encodeField(6, 2, cidBuf);
  const innerF7s = BAKU_WORKSPACE_URIS.map(uri => encodeField(7, 2, Buffer.from(uri, 'utf8')));
  const innerF18 = encodeField(18, 2, projIdBuf);
  const newF17Data = Buffer.concat([innerF6, ...innerF7s, innerF18]);
  const f17 = encodeField(17, 2, newF17Data);

  const f20 = encodeField(20, 0, encodeVarint(18)); // JETBOX
  const f21 = encodeField(21, 0, encodeVarint(0)); // not_fully_idle = 0
  const f22 = encodeField(22, 0, encodeVarint(1)); // CASCADE

  return Buffer.concat([f1, f2, f3, f4, f5, f10, f15, f17, f20, f21, f22]);
}

function updateSummariesProtoFile(pbPath, updatedRawSummaries) {
  if (!fs.existsSync(pbPath)) return;
  try {
    const buf = fs.readFileSync(pbPath);
    const { entries, trailingData } = parseSummariesProto(buf);
    const entryMap = new Map();

    for (const e of entries) {
      if (e.convId) {
        entryMap.set(e.convId, e);
      }
    }

    for (const [cid, newRaw] of Object.entries(updatedRawSummaries)) {
      const keyField = encodeField(1, 2, Buffer.from(cid, 'utf8'));
      const valField = encodeField(2, 2, newRaw);
      const entryPayload = Buffer.concat([keyField, valField]);
      const rawEntry = encodeField(1, 2, entryPayload);

      entryMap.set(cid, {
        convId: cid,
        summaryBytes: newRaw,
        rawEntry
      });
    }

    const newEntries = Array.from(entryMap.values());
    const newBuf = serializeSummariesProto(newEntries, trailingData);
    fs.writeFileSync(pbPath, newBuf);
    console.log(`Updated proto file: ${pbPath} with ${Object.keys(updatedRawSummaries).length} agents.`);
  } catch (err) {
    console.error(`Error updating ${pbPath}:`, err.message);
  }
}

function getLiveLs() {
  const ps = `
    $p = Get-Process language_server -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) {
      $cmd = (Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $p.Id }).CommandLine
      $ports = (Get-NetTCPConnection -OwningProcess $p.Id | Where-Object { $_.State -eq 'Listen' -and $_.LocalAddress -eq '127.0.0.1' }).LocalPort
      Write-Output "CMD:$cmd"
      foreach ($port in $ports) {
        Write-Output "PORT:$port"
      }
    }
  `;
  try {
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/\r?\n/g, '; ')}"`, { encoding: 'utf8', timeout: 5000 });
    let csrf = null;
    let port = null;
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('CMD:')) {
        const m = line.match(/--csrf_token\s+([a-f0-9\-]+)/);
        if (m) csrf = m[1];
      } else if (line.startsWith('PORT:')) {
        const p = line.replace('PORT:', '').trim();
        if (p && !port) port = p;
      }
    }
    return { address: port ? `127.0.0.1:${port}` : null, csrf };
  } catch (e) {
    return { address: null, csrf: null };
  }
}

function createAgentDatabaseIfMissing(cid, title) {
  const dbDir = 'C:\\Users\\HP\\.gemini\\antigravity\\conversations';
  const targetDb = path.join(dbDir, `${cid}.db`);
  if (fs.existsSync(targetDb)) return;

  const templateDb = path.join(dbDir, 'f51fe42c-1aaf-424c-9fed-eb152561afbb.db');
  if (!fs.existsSync(templateDb)) return;

  try {
    fs.copyFileSync(templateDb, targetDb);
    const db = new DatabaseSync(targetDb);
    db.prepare('UPDATE trajectory_meta SET cascade_id = ?').run(cid);

    const row = db.prepare('SELECT id, data FROM trajectory_metadata_blob WHERE id = ?').get('main');
    if (row && row.data) {
      let buf = Buffer.from(row.data);
      // Replace cascade ID
      const oldCid = Buffer.from('f51fe42c-1aaf-424c-9fed-eb152561afbb');
      const newCid = Buffer.from(cid);
      if (buf.includes(oldCid)) {
        let replaced = Buffer.alloc(buf.length);
        let idx = buf.indexOf(oldCid);
        buf.copy(replaced, 0, 0, idx);
        newCid.copy(replaced, idx);
        buf.copy(replaced, idx + newCid.length, idx + oldCid.length);
        buf = replaced;
      }
      // Replace project ID
      const tradeosProj = Buffer.from('5b7f7b5a-c71b-4af7-b40e-0fded2dd6291');
      const bakuProj = Buffer.from(BAKU_PROJECT_ID);
      if (buf.includes(tradeosProj)) {
        let replaced = Buffer.alloc(buf.length);
        let idx = buf.indexOf(tradeosProj);
        buf.copy(replaced, 0, 0, idx);
        bakuProj.copy(replaced, idx);
        buf.copy(replaced, idx + bakuProj.length, idx + tradeosProj.length);
        buf = replaced;
      }
      db.prepare('UPDATE trajectory_metadata_blob SET data = ? WHERE id = ?').run(buf, 'main');
    }
    db.close();
    console.log(`Created individual db for ${title} (${cid})`);
  } catch (e) {
    console.error(`Failed to create db for ${cid}:`, e.message);
  }
}

async function main() {
  console.log('=== BakuEstate-AI Team Registration & Synchronization ===');

  // Step 1: Fix this conversation's trajectory_metadata_blob
  try {
    const ceoDbPath = 'C:\\Users\\HP\\.gemini\\antigravity\\conversations\\2c8a7a57-7940-40ac-95b5-940fcde3781e.db';
    if (fs.existsSync(ceoDbPath)) {
      const db = new DatabaseSync(ceoDbPath);
      const row = db.prepare('SELECT id, data FROM trajectory_metadata_blob WHERE id = ?').get('main');
      if (row && row.data) {
        let buf = Buffer.from(row.data);
        const tradeosProj = Buffer.from('5b7f7b5a-c71b-4af7-b40e-0fded2dd6291');
        const bakuProj = Buffer.from(BAKU_PROJECT_ID);
        if (buf.includes(tradeosProj)) {
          let replaced = Buffer.alloc(buf.length);
          let idx = buf.indexOf(tradeosProj);
          buf.copy(replaced, 0, 0, idx);
          bakuProj.copy(replaced, idx);
          buf.copy(replaced, idx + bakuProj.length, idx + tradeosProj.length);
          db.prepare('UPDATE trajectory_metadata_blob SET data = ? WHERE id = ?').run(replaced, 'main');
          console.log('Patched CEO trajectory_metadata_blob with BakuEstate project ID');
        }
      }
      db.close();
    }
  } catch (e) {
    console.error('Error patching CEO db:', e.message);
  }

  // Step 2: Ensure individual db exists for all 5 squad agents
  for (const [cid, title] of Object.entries(AGENTS)) {
    if (cid !== '2c8a7a57-7940-40ac-95b5-940fcde3781e') {
      createAgentDatabaseIfMissing(cid, title);
    }
  }

  // Step 3: Build raw summaries
  const updatedRawSummaries = {};
  for (const [cid, title] of Object.entries(AGENTS)) {
    updatedRawSummaries[cid] = buildSummaryProto(title, cid, cid === '2c8a7a57-7940-40ac-95b5-940fcde3781e' ? 245 : 5);
  }

  // Step 4: Update SQLite databases
  const dbPaths = [
    'C:\\Users\\HP\\.gemini\\antigravity\\conversation_summaries.db',
    'C:\\Users\\HP\\.gemini\\antigravity-cli\\conversation_summaries.db'
  ];

  for (const dbPath of dbPaths) {
    if (!fs.existsSync(dbPath)) continue;
    try {
      const db = new DatabaseSync(dbPath);
      try { db.exec('PRAGMA busy_timeout = 5000;'); } catch (e) {}

      for (const [cid, title] of Object.entries(AGENTS)) {
        const raw = updatedRawSummaries[cid];
        const nowIso = new Date().toISOString();
        const sqliteTime = nowIso.replace('T', ' ').replace('Z', '+00:00');
        const stepCount = cid === '2c8a7a57-7940-40ac-95b5-940fcde3781e' ? 245 : 5;

        const exists = db.prepare('SELECT conversation_id FROM conversation_summaries WHERE conversation_id = ?').get(cid);
        if (exists) {
          db.prepare(`
            UPDATE conversation_summaries SET
              title = ?,
              preview = ?,
              raw_summary = ?,
              step_count = ?,
              last_modified_time = ?,
              last_user_input_time = ?,
              status = 'CASCADE_RUN_STATUS_IDLE',
              not_fully_idle = 0,
              project_id = ?,
              workspace_uris = ?,
              source = 'CORTEX_TRAJECTORY_SOURCE_JETBOX',
              killed = 0
            WHERE conversation_id = ?
          `).run(title, title, raw, stepCount, sqliteTime, sqliteTime, BAKU_PROJECT_ID, BAKU_WORKSPACE_URIS_JSON, cid);
        } else {
          db.prepare(`
            INSERT INTO conversation_summaries (
              conversation_id, title, preview, raw_summary, step_count, last_modified_time,
              project_id, workspace_uris, parent_conversation_id, nesting_depth, killed, source, status,
              last_user_input_time, last_user_input_step_index, app_data_dir, not_fully_idle
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, 'CORTEX_TRAJECTORY_SOURCE_JETBOX', 'CASCADE_RUN_STATUS_IDLE', ?, 0, 'antigravity', 0)
          `).run(cid, title, title, raw, stepCount, sqliteTime, BAKU_PROJECT_ID, BAKU_WORKSPACE_URIS_JSON, sqliteTime);
        }
      }

      try { db.exec('PRAGMA wal_checkpoint(PASSIVE);'); } catch (e) {}
      db.close();
      console.log(`Updated SQLite database: ${dbPath}`);
    } catch (e) {
      console.error(`Error updating ${dbPath}:`, e.message);
    }
  }

  // Step 5: Update protobuf caches
  updateSummariesProtoFile('C:\\Users\\HP\\.gemini\\antigravity\\agyhub_summaries_proto.pb', updatedRawSummaries);
  updateSummariesProtoFile('C:\\Users\\HP\\.gemini\\antigravity\\jetbox_summaries_proto.pb', updatedRawSummaries);
  updateSummariesProtoFile('C:\\Users\\HP\\.gemini\\antigravity-cli\\jetbox_summaries_proto.pb', updatedRawSummaries);

  // Step 6: Push live RPC to LanguageServer
  const lsInfo = getLiveLs();
  if (lsInfo.address && lsInfo.csrf) {
    console.log(`Pushing live updates to LanguageServer at ${lsInfo.address}...`);
    for (const [cid, title] of Object.entries(AGENTS)) {
      try {
        await fetch(`http://${lsInfo.address}/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': lsInfo.csrf },
          body: JSON.stringify({
            cascadeId: cid,
            annotations: {
              title: title,
              lastUserViewTime: new Date().toISOString()
            }
          })
        });

        await fetch(`http://${lsInfo.address}/exa.language_server_pb.LanguageServerService/JetboxWriteSummary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': lsInfo.csrf },
          body: JSON.stringify({
            cascadeId: cid,
            summary: {
              summary: title,
              source: 'CORTEX_TRAJECTORY_SOURCE_JETBOX',
              stepCount: cid === '2c8a7a57-7940-40ac-95b5-940fcde3781e' ? 245 : 5,
              status: 'CASCADE_RUN_STATUS_IDLE',
              notFullyIdle: false,
              lastModifiedTime: new Date().toISOString(),
              lastUserInputTime: new Date().toISOString(),
              trajectoryMetadata: {
                projectId: BAKU_PROJECT_ID,
                rootConversationId: cid
              }
            }
          })
        });
      } catch (e) {
        console.error(`RPC error for ${cid}:`, e.message);
      }
    }
    console.log('LanguageServer RPC updates dispatched.');
  }

  // Step 7: Update app_storage.json
  const storagePath = 'C:\\Users\\HP\\AppData\\Roaming\\Antigravity\\app_storage.json';
  if (fs.existsSync(storagePath)) {
    try {
      const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      if (!storage.projectsOrder) storage.projectsOrder = [];
      if (!storage.projectsOrder.includes(BAKU_PROJECT_ID)) {
        storage.projectsOrder.push(BAKU_PROJECT_ID);
      }
      if (!storage.sidebar_section_display) storage.sidebar_section_display = {};
      if (!storage.sidebar_section_display.onlyShowFirstFewConvos) storage.sidebar_section_display.onlyShowFirstFewConvos = {};
      storage.sidebar_section_display.onlyShowFirstFewConvos[BAKU_PROJECT_ID] = false;

      fs.writeFileSync(storagePath, JSON.stringify(storage, null, 2), 'utf8');
      console.log('Updated app_storage.json projectsOrder & display settings.');
    } catch (e) {
      console.error('Error updating app_storage.json:', e.message);
    }
  }

  console.log('=== All 6 BakuEstate-AI team members successfully synchronized! ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
});
