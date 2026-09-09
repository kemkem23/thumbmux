// Offline synthetic benchmark. No tmux, network, host paths or production DB.
import { fixture,batch,ids } from './helpers';
import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
const f=fixture();
try {
 const sid=await f.store.register({name:'million',lifecycleKey:'synthetic-million'});
 const durations:number[]=[];
 for(let start=0;start<1000000;start+=500){
   const t=performance.now();await f.store.commit(batch(f.store,sid,ids(500,start)));durations.push(performance.now()-t);
 }
 const audit=f.store.audit(sid);if(audit.rows!==1000000)throw new Error('million-fixture-incomplete');
 f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 await f.store.close();chmodSync(f.file,0o400);
 const reader=new Database(f.file,{readonly:true});
 const results=[];
 for(const direction of ['ASC','DESC'])for(const count of [500,2000]){
   const sql=`SELECT line_no,kind,text FROM history_line WHERE session_id=? AND line_no>=? AND line_no<? ORDER BY line_no ${direction} LIMIT ?`;
   const plan=reader.query('EXPLAIN QUERY PLAN '+sql).all(sid,400000,600000,count) as {detail:string}[];
   if(!plan.some(p=>p.detail.includes('SEARCH')&&p.detail.includes('PRIMARY KEY'))||plan.some(p=>/SCAN|TEMP B-TREE/.test(p.detail)))throw new Error('range-query-plan');
   const samples:number[]=[];
   for(let trial=0;trial<30;trial++){
     const t=performance.now();const rows=reader.query(sql).all(sid,400000,600000,count) as {line_no:number;text:string}[];samples.push(performance.now()-t);
     if(rows.length!==count||rows.some((r,i)=>r.line_no!==(direction==='ASC'?400000+i:599999-i)))throw new Error('benchmark-oracle');
   }
   samples.sort((a,b)=>a-b);results.push({direction,count,plan,p50ms:samples[15],p95ms:samples[28],maxMs:samples[29]});
 }
 reader.close();durations.sort((a,b)=>a-b);
 console.log(JSON.stringify({rows:audit.rows,captures:audit.captures,fixture:'closed writer, checkpointed, chmod 0400, readonly connection',batch500:{p50ms:durations[1000],p95ms:durations[1900],maxMs:durations.at(-1)},results},null,2));
}finally{await f.cleanup();}
