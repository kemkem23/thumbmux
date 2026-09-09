import { Database } from 'bun:sqlite';
import { HistoryStore } from '../../src/sqlite-history/store';
import { batch } from './helpers';
const [file,sid,point]=process.argv.slice(2);
const db=new Database(file),store=new HistoryStore(db,{file});
const die=()=>process.kill(process.pid,'SIGKILL');
const original=db.query.bind(db);
(db as any).query=(sql:string)=>{
  const statement=original(sql);
  return new Proxy(statement,{get(target,key){
    if(key==='run')return (...args:any[])=>{
      if(point==='before-boundary'&&sql.startsWith('UPDATE history_session SET revision='))die();
      const result=(target.run as any)(...args);
      if(point==='after-row'&&sql.startsWith('INSERT INTO history_line VALUES'))die();
      return result;
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
};
if(point==='before-transaction')die();
await store.commit(batch(store,sid,['after crash boundary','ไทย'],['new screen'],'crash-request'),point==='before-commit'?die:undefined);
die();
