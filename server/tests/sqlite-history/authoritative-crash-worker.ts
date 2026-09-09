/**
 * Wave 5 kill worker. The death is a real SIGKILL of this process at one named
 * cut point inside an authoritative commit: four points inside the SQLite
 * transaction (statement proxy, as in wave 1) and four filesystem stages of the
 * mirror export (the bridge's stage callback places the kill between two
 * durable states; the kill itself is not simulated).
 */
import { Database } from 'bun:sqlite';
import { HistoryStore } from '../../src/sqlite-history/store';
import { AuthoritativeHistoryBridge } from '../../src/sqlite-history/authoritative';
import { batch } from './helpers';

const [file, mirror, sid, point] = process.argv.slice(2);
const die = () => process.kill(process.pid, 'SIGKILL');
const db = new Database(file), store = new HistoryStore(db, { file });
const original = db.query.bind(db);
(db as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
  const statement = original(sql);
  return new Proxy(statement, { get(target, key) {
    if (key === 'run') return (...args: unknown[]) => {
      if (point === 'before-boundary' && sql.startsWith('UPDATE history_session SET revision=')) die();
      const result = (target.run as (...values: unknown[]) => unknown)(...args);
      if (point === 'after-row' && sql.startsWith('INSERT INTO history_line VALUES')) die();
      if (point === 'before-commit' && sql.startsWith('UPDATE history_session SET revision=')) die();
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
};
const bridge = new AuthoritativeHistoryBridge(store, {
  mirrorDirectory: mirror,
  driver: { geometryGeneration: () => 1, capture: () => Promise.reject(new Error('unused')) },
  sessions: () => [],
  stage: stage => { if (stage === point) die(); },
});
if (point === 'before-transaction') die();
await bridge.commitBatch(batch(store, sid, ['after crash boundary', 'ไทย漢字\x1b[31mกข', ''], ['new screen'], 'crash-request'));
die();
