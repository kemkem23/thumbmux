import { test, expect } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Edit={file:string;from:string;to:string};
type Mutant={name:string;pattern:string;edits:Edit[]};

test('wave2 detectors kill bridge/import/manifest/oracle mutants and clean tree passes before and after',async()=>{
  const pkg=resolve(import.meta.dir,'../..'),root=mkdtempSync(join(tmpdir(),'thumbmux-sqlite-wave2-mutants-'));
  const mutants:Mutant[]=[
    {name:'accept-lying-legacy-receipt',pattern:'lying legacy acknowledgement',edits:[{file:'detectors.ts',
      from:"if(acknowledgement.requestId!==projection.requestId || acknowledgement.digest!==digest)",to:'if(false)'}]},
    {name:'skip-legacy-write',pattern:'spools one capture',edits:[{file:'bridge.ts',from:'if (!entry.legacyCommitted) {',to:'if (false) {'}]},
    {name:'repeat-legacy-after-restart',pattern:'resumes after SQLite failure',edits:[{file:'bridge.ts',from:'if (!entry.legacyCommitted) {',to:'if (true) {'}]},
    {name:'ignore-row-diff',pattern:'every injected mismatch',edits:[{file:'rehearsal.ts',
      from:"if (rowsDigest(oracle.rows) !== rowsDigest(observedRows))",to:'if (false)'}]},
    {name:'ignore-frame-diff',pattern:'frame oracle compares',edits:[{file:'rehearsal.ts',
      from:"if (digestFrames(oracle.frames) !== digestFrames(observedFrames))",to:'if (false)'}]},
    {name:'ignore-unresolved-capture',pattern:'every injected mismatch',edits:[{file:'rehearsal.ts',
      from:"if (raw.count) unresolved.push",to:'if (false) unresolved.push'}]},
    {name:'ignore-unresolved-ledger',pattern:'every injected mismatch',edits:[{file:'rehearsal.ts',
      from:"if (report.unresolved.length || !report.ready)",to:'if (false)'}]},
    {name:'collapse-import-request-identity',pattern:'resumes persisted checkpoint',edits:[{file:'transfer.ts',
      from:'`import:${input.sourceId}:${from}`',to:'`import:${input.sourceId}:constant`'}]},
    {name:'silence-progress-watchdog',pattern:'checkpoint detector cries',edits:[{file:'detectors.ts',
      from:"if(progress.state==='verified' || progress.state==='quarantined' || now-progress.checkpointAt<=30000)return null;",to:'return null;'}]},
    {name:'drop-batch-progress-notification',pattern:'resumes persisted checkpoint',edits:[{file:'transfer.ts',
      from:'cursor=to;notify();await new Promise<void>',to:'cursor=to;await new Promise<void>'}]},
    {name:'ignore-unlisted-sealed-file',pattern:'every injected mismatch',edits:[{file:'transfer.ts',
      from:"if(names(directory).filter(n=>n!=='seal.json').length!==files.size)",to:'if(false)'}]},
  ];
  try {
    mkdirSync(join(root,'server'),{recursive:true});cpSync(join(pkg,'server/src'),join(root,'server/src'),{recursive:true});
    mkdirSync(join(root,'server/tests/sqlite-history'),{recursive:true});
    cpSync(join(pkg,'server/tests/sqlite-history-wave2.test.ts'),join(root,'server/tests/sqlite-history-wave2.test.ts'));
    cpSync(join(pkg,'server/tests/sqlite-history/helpers.ts'),join(root,'server/tests/sqlite-history/helpers.ts'));
    mkdirSync(join(root,'node_modules/@thumbmux'),{recursive:true});symlinkSync(join(pkg,'core'),join(root,'node_modules/@thumbmux/core'),'dir');
    writeFileSync(join(root,'package.json'),'\n{"type":"module"}\n');
    const run=async(name:string,pattern?:string)=>{
      const args=[process.execPath,'test','./server/tests/sqlite-history-wave2.test.ts'];if(pattern)args.push('--test-name-pattern',pattern);
      const process=Bun.spawn(args,{cwd:root,stdout:'pipe',stderr:'pipe'});
      const [code,out,err]=await Promise.all([process.exited,new Response(process.stdout).text(),new Response(process.stderr).text()]);
      const output=out+err;console.log('MUTANT_RUN',JSON.stringify({name,code,ran:/Ran \d+ tests?/.test(output),failed:output.includes('(fail)')}));
      return {code,output};
    };
    expect((await run('clean-before')).code).toBe(0);
    for(const mutant of mutants){
      const originals=new Map<string,string>();
      for(const edit of mutant.edits){
        const path=join(root,'server/src/sqlite-history',edit.file),current=readFileSync(path,'utf8');
        originals.set(path,current);expect(current.includes(edit.from)).toBe(true);writeFileSync(path,current.replace(edit.from,edit.to));
      }
      const result=await run(mutant.name,mutant.pattern);
      for(const [path,contents] of originals)writeFileSync(path,contents);
      expect(result.code).not.toBe(0);expect(result.output).toContain('(fail)');
      expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
    }
    expect((await run('clean-after')).code).toBe(0);
    console.log('MUTATION_RESULT',JSON.stringify({killed:mutants.length,survived:0,cleanBefore:true,cleanAfter:true}));
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
