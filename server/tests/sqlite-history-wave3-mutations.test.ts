import { test, expect } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Mutant={name:string;pattern:string;file:string;from:string;to:string};

test('wave3 shadow detectors kill every injected fault and clean tree passes before and after',async()=>{
  const pkg=resolve(import.meta.dir,'../..'),root=mkdtempSync(join(tmpdir(),'thumbmux-sqlite-wave3-mutants-'));
  const mutants:Mutant[]=[
    {name:'accept-receipt-mismatch',pattern:'receipt, line, frame',file:'detectors.ts',from:'if(!receipts.match)faults.push',to:'if(false)faults.push'},
    {name:'accept-line-mismatch',pattern:'receipt, line, frame',file:'detectors.ts',from:'if(lineBytes.length||lineKinds.length||lines.legacyOnly.length||lines.sqliteOnly.length)faults.push',to:'if(false)faults.push'},
    {name:'accept-frame-mismatch',pattern:'receipt, line, frame',file:'detectors.ts',from:'if(frames.mismatches.length||frames.leftOnly.length||frames.rightOnly.length)faults.push',to:'if(false)faults.push'},
    {name:'accept-unresolved-mismatch',pattern:'receipt, line, frame',file:'detectors.ts',from:'if(unresolved.mismatches.length||unresolved.leftOnly.length||unresolved.rightOnly.length)faults.push',to:'if(false)faults.push'},
    {name:'trust-two-wrong-projections',pattern:'independent source oracle',file:'detectors.ts',from:"if(source.status==='mismatch')faults.push",to:'if(false)faults.push'},
    {name:'silence-collector-stale',pattern:'pure shadow runtime detector',file:'detectors.ts',from:'if(now-last>staleAfterMs || state.inFlightSince!==null&&now-state.inFlightSince>staleAfterMs)findings.push',to:'if(false)findings.push'},
    {name:'silence-export-lag',pattern:'pure shadow runtime detector',file:'detectors.ts',from:'if(state.targetRevision>state.exportedRevision && state.exportLagSince!==null && now-state.exportLagSince>staleAfterMs)findings.push',to:'if(false)findings.push'},
    {name:'silence-write-failure',pattern:'pure shadow runtime detector',file:'detectors.ts',from:'if(state.lastWriteFailure)findings.push',to:'if(false)findings.push'},
    {name:'drop-comparison-delivery',pattern:'delivery is persisted',file:'bridge.ts',from:'if(!entry.shadowDelivered) {',to:'if(false) {'},
  ];
  try {
    mkdirSync(join(root,'server'),{recursive:true});cpSync(join(pkg,'server/src'),join(root,'server/src'),{recursive:true});
    mkdirSync(join(root,'server/tests/sqlite-history'),{recursive:true});
    cpSync(join(pkg,'server/tests/sqlite-history-wave3.test.ts'),join(root,'server/tests/sqlite-history-wave3.test.ts'));
    cpSync(join(pkg,'server/tests/sqlite-history/helpers.ts'),join(root,'server/tests/sqlite-history/helpers.ts'));
    const copiedCore=join(root,'node_modules/@thumbmux/core');mkdirSync(copiedCore,{recursive:true});
    cpSync(join(pkg,'core/src'),join(copiedCore,'src'),{recursive:true});
    writeFileSync(join(copiedCore,'package.json'),'\n{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}\n');
    writeFileSync(join(root,'package.json'),'\n{"type":"module"}\n');
    const run=async(name:string,pattern?:string)=>{
      const args=[process.execPath,'test','./server/tests/sqlite-history-wave3.test.ts'];if(pattern)args.push('--test-name-pattern',pattern);
      const child=Bun.spawn(args,{cwd:root,stdout:'pipe',stderr:'pipe'});
      const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      const output=out+err;console.log('WAVE3_MUTANT_RUN',JSON.stringify({name,code,ran:/Ran \d+ tests?/.test(output),failed:output.includes('(fail)')}));
      if(code!==0&&!output.includes('(fail)'))console.log('WAVE3_MUTANT_INVALID_OUTPUT',output);
      return {code,output};
    };
    expect((await run('clean-before')).code).toBe(0);
    for(const mutant of mutants){
      const path=join(root,'server/src/sqlite-history',mutant.file),original=readFileSync(path,'utf8');
      expect(original.includes(mutant.from)).toBe(true);writeFileSync(path,original.replace(mutant.from,mutant.to));
      const result=await run(mutant.name,mutant.pattern);writeFileSync(path,original);
      expect(result.code).not.toBe(0);expect(result.output).toContain('(fail)');
      expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
    }
    expect((await run('clean-after')).code).toBe(0);
    console.log('WAVE3_MUTATION_RESULT',JSON.stringify({killed:mutants.length,survived:0,cleanBefore:true,cleanAfter:true}));
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
