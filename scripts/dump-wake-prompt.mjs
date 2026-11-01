import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/Administrator/.workbuddy/workbuddy.db');
const rows = db
  .prepare(
    `SELECT id, name, prompt, skills_json, cwds, permission_mode
     FROM automations WHERE name LIKE 'QQBOT%' ORDER BY rowid DESC LIMIT 2`
  )
  .all();

for (const r of rows) {
  console.log('=========', r.name, r.id.slice(0, 8), '=========');
  console.log('skills_json =', r.skills_json);
  console.log('cwds =', r.cwds);
  console.log('prompt 长度 =', String(r.prompt || '').length);
  console.log('----- prompt 全文 -----');
  console.log(r.prompt);
  console.log();
}
db.close();
