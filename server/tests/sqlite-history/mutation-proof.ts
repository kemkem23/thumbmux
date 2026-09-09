// Each mutant lives in a throwaway package copy. Never edit the working implementation.
import { mkdtempSync,cpSync,symlinkSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
const pkg=resolve(import.meta.dir,'../../..'),root=mkdtempSync(join(tmpdir(),'thumbmux-sqlite-mutants-'));
const mutations:Array<[string,string,string,string,string]>=[
 ['storage-hole','store.ts','    if (rows.length!==end-start || rows.some((r,i)=>r.line_no!==start+i))','    if (false)','storage-hole detector'],
 ['byte-digest','codec.ts',"  const h = createHash('sha256');","  return 'mutant-constant';\n  const h = createHash('sha256');",'storage-hole detector'],
 ['original-oracle','detectors.ts','  if(!expected.length)', '  return;\n  if(!expected.length)','source oracle'],
 ['viewer-context','detectors.ts','  if(JSON.stringify(context)', '  return;\n  if(JSON.stringify(context)','both paging directions'],
 ['viewer-extent','detectors.ts','page.rows.length!==page.endLine-page.startLine || ','','watchdog mirror/commit'],
 ['watchdog','detectors.ts','  const findings:HistoryFault[]=[];','  return [];\n  const findings:HistoryFault[]=[];','deadline isolates'],
 ['mirror','detectors.ts','  return exportedRevision<targetRevision','  return false && exportedRevision<targetRevision','watchdog mirror/commit'],
 ['source-unknown','store.ts',"continuity:'unknown'},requestId", "continuity:'verified'},requestId",'ring overflow'],
 ['writer-fence','store.ts',"    if (this.closed)","    return;\n    if (this.closed)",'ownership takeover'],
 ['retry-identity','store.ts',"if (JSON.parse(previous.evidence_json).requestDigest !== requestDigest)","if (false)",'append/receipt triggers'],
 ['frame-validator','store.ts',"    parseReplayJournal([...preceding.map(r=>r.record_json),line].join('\\n')+'\\n');","    // validator removed",'frame validator'],
 ['import-tail','transfer.ts',"if(from!==bytes.length)throw new Error('partial-jsonl-tail');","// partial tail silently accepted",'partial UTF8'],
 ['import-quarantine','transfer.ts',"const state=parsed.error?'quarantined':'verified';","const state='verified';",'partial UTF8'],
 ['append-trigger','schema.ts'," SELECT CASE WHEN NEW.line_no != (SELECT next_line FROM history_session WHERE session_id=NEW.session_id)"," SELECT CASE WHEN 0",'append/receipt triggers'],
 ['retention-trigger','schema.ts'," SELECT RAISE(ABORT,'retention-disabled');"," SELECT 1;",'append/receipt triggers'],
 ['receipt-trigger','schema.ts'," THEN RAISE(ABORT,'receipt-mismatch') END;"," THEN NULL END;",'append/receipt triggers'],
 ['drain','coordinator.ts','.finally(()=>clearTimeout(timer!));',".finally(()=>clearTimeout(timer!));if(this.stopped)throw new Error('dropped in-flight capture');",'stopAndDrain finishes'],
 ['precommit-ws','coordinator.ts','      const receipt=await this.store.commit(batch);',"      await this.options.publish?.({context:{revision:ticket.revision+1}} as CaptureReceipt);\n      const receipt=await this.store.commit(batch);",'COMMIT is visible'],
 ['recording-cap','store.ts','if(sessionBytes.bytes+size>(frozen.recordingSessionBytes??64*1024*1024) || rootBytes.bytes+size>(frozen.recordingRootBytes??256*1024*1024))','if(false)','recording limit'],
 ['restore-screen','transfer.ts','c.at,c.geometry_json,c.screen_json,',"c.at,c.geometry_json,'[]',",'bundle restore'],
];
try {
 mkdirSync(join(root,'server'),{recursive:true});cpSync(join(pkg,'server/src'),join(root,'server/src'),{recursive:true});
 mkdirSync(join(root,'server/tests/sqlite-history'),{recursive:true});
 cpSync(join(pkg,'server/tests/sqlite-history.test.ts'),join(root,'server/tests/sqlite-history.test.ts'));
 cpSync(join(pkg,'server/tests/sqlite-history/helpers.ts'),join(root,'server/tests/sqlite-history/helpers.ts'));
 cpSync(join(pkg,'server/tests/sqlite-history/crash-worker.ts'),join(root,'server/tests/sqlite-history/crash-worker.ts'));
 mkdirSync(join(root,'node_modules/@thumbmux'),{recursive:true});symlinkSync(join(pkg,'core'),join(root,'node_modules/@thumbmux/core'),'dir');
 writeFileSync(join(root,'package.json'),'{"type":"module"}');
 async function run(name:string,pattern?:string):Promise<{code:number;output:string}> {
  const args=[process.execPath,'test','./server/tests/sqlite-history.test.ts'];if(pattern)args.push('--test-name-pattern',pattern);
  const p=Bun.spawn(args,{cwd:root,stdout:'pipe',stderr:'pipe'});
  const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
  console.log(`\n=== ${name} exit=${code} ===\n${out}${err}`);return {code,output:out+err};
 }
 if((await run('clean-before')).code!==0)throw new Error('clean baseline failed');
 for(const [name,file,from,to,pattern]of mutations){
  const path=join(root,'server/src/sqlite-history',file),original=readFileSync(path,'utf8');
  if(!original.includes(from)||from===to)throw new Error(`mutation not applied: ${name}`);
  writeFileSync(path,original.replace(from,to));
  const result=await run(name,pattern);writeFileSync(path,original);
  if(result.code===0||!result.output.includes('(fail)')||/SyntaxError|ParseError|Cannot find module/.test(result.output))throw new Error(`mutant survived or invalid: ${name}`);
 }
 if((await run('clean-after')).code!==0)throw new Error('clean restoration failed');
 console.log(`MUTATION_RESULT: ${mutations.length} mutants killed by real bun:test failures; clean before/after passed`);
}finally{rmSync(root,{recursive:true,force:true});}
