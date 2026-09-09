import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { HistoryStore, prepareFile } from '../../src/sqlite-history/store';
import type { CaptureObservation, CaptureBatch, HistoryFault } from '../../src/sqlite-history/types';
import { sha } from '../../src/sqlite-history/codec';
export function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'thumbmux-sqlite-')),file=prepareFile(join(dir,'history.db'));
  const db=new Database(file,{strict:true}),alarms:HistoryFault[]=[];
  const store=new HistoryStore(db,{file,onFault:f=>alarms.push(f)});
  return {dir,file,db,store,alarms,async cleanup(){await store.close();rmSync(dir,{recursive:true,force:true});}};
}
export function observation(raw:string[],rows=40,generation=1):CaptureObservation {
  return {raw,screen:raw.slice(-rows),geometry:{kind:'pane',rows,cols:80,generation,alternate:false,cursor:null},at:100,source:{}};
}
export function ids(n:number,start=0):string[]{return Array.from({length:n},(_,i)=>`row:${i+start}:ไทย漢字\x1b[31m${i%5===0?'':'OK'}`);}
export function batch(store:HistoryStore,sid:string,lines:string[],screen:string[]=['screen'],requestId?:string):CaptureBatch {
  const o=observation([...lines,...screen],screen.length);
  return {ticket:store.ticket(sid,requestId),observation:o,appended:lines.map(text=>({kind:'terminal',text})),liveLineLimit:screen.length,
    evidence:{classification:'initial',depth:'shallow',source:{},rawSha256:sha(JSON.stringify(o))}};
}
export function evidence(fault:HistoryFault|undefined):void {
  if(!fault)throw new Error('missing-alarm-receipt');
  console.log('FAULT_RECEIPT',JSON.stringify({...fault,alarm_receipt:`test-sink:${fault.issue_id}`}));
}
