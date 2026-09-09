import { randomUUID } from 'node:crypto';
import { locateAnchor } from '../history-stitch';
import { sha, validateObservation, safe } from './codec';
import type { HistoryStore } from './store';
import type { CaptureBatch, CaptureObservation, CaptureReceipt, HistoryCoordinatorOptions, HistoryEvidence } from './types';

export type CaptureBatchCommitter = (batch: CaptureBatch) => Promise<CaptureReceipt>;

/** No work starts until start()/probe(). Neither subscribers nor a global ticking flag gate captures. */
export class HistoryCoordinator {
  private running=new Map<string,Promise<CaptureReceipt>>();
  private pending=new Map<string, import('./types').CaptureBatch>();
  private timer:ReturnType<typeof setInterval>|null=null;
  private stopped=false;
  constructor(private store:HistoryStore,private options:HistoryCoordinatorOptions,
    private commitBatch:CaptureBatchCommitter=(batch)=>store.commit(batch)) {
    safe(options.recordingSessionBytes??64*1024*1024);safe(options.recordingRootBytes??256*1024*1024);safe(options.intervalMs??10000);safe(options.deadlineMs??5000);safe(options.liveLineLimit??1000);
    if((options.intervalMs??10000)<1 || (options.deadlineMs??5000)<1) throw new Error('invalid-deadline');
    store.addDrain(()=>this.stopAndDrain());
  }
  start():void {
    if(this.timer) return; this.stopped=false;
    const tick=()=>{for(const sid of this.options.sessions()) void this.probe(sid).catch(()=>{});};
    tick();this.timer=setInterval(tick,this.options.intervalMs??10000);
  }
  probe(sid:string):Promise<CaptureReceipt> {
    if(this.stopped) return Promise.reject(new Error('coordinator-stopped'));
    const existing=this.running.get(sid);if(existing)return existing;
    const task=this.collect(sid).finally(()=>this.running.delete(sid));
    this.running.set(sid,task);return task;
  }
  private async collect(sid:string):Promise<CaptureReceipt> {
    try {
      // Retry a failed commit with the original observation and request ID, never a recapture.
      const retry=this.pending.get(sid);
      if(retry) {const receipt=await this.commitBatch(retry);this.pending.delete(sid);await this.publish(receipt);return receipt;}
      const ticket=this.store.ticket(sid,randomUUID());
      const generation=this.options.driver.geometryGeneration(sid);
      const abort=new AbortController();
      let timer:ReturnType<typeof setTimeout>;
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error('capture-deadline'));},this.options.deadlineMs??5000);});
      const run=async()=>{
        let o=await this.options.driver.capture(sid,'shallow',abort.signal);
        validateObservation(o);
        const tail=this.store.tail(sid).map(r=>r.text);
        const classify=(v:CaptureObservation):HistoryEvidence['classification']=>{
          if(v.geometry.alternate || v.source.reset)return 'geometry';
          if(v.geometry.generation!==generation || this.options.driver.geometryGeneration(sid)!==generation) return 'geometry';
          if(!v.raw.length || v.raw.length<=v.screen.length)return 'empty';
          if(!tail.length)return 'initial';
          const match=locateAnchor(v.raw.slice(0,v.raw.length-v.screen.length),tail);
          return typeof match==='string'?match:'overlap';
        };
        let classification=classify(o),depth:'shallow'|'deep'='shallow';
        if(['missing','ambiguous','empty'].includes(classification)) {
          depth='deep';o=await this.options.driver.capture(sid,'deep',abort.signal);validateObservation(o);classification=classify(o);
        }
        return {o,tail,classification,depth};
      };
      const {o,tail,classification,depth}=await Promise.race([run(),timeout]).finally(()=>clearTimeout(timer!));
      const stable=o.raw.slice(0,o.raw.length-o.screen.length);
      let appended:Array<{kind:'terminal'|'gap';text:string}>=[];
      const unresolved=classification!=='initial'&&classification!=='overlap';
      if(classification==='geometry') {
        // Keep raw evidence/screen as an unresolved observation; never promote stale geometry rows.
        appended=[];
      } else if(classification==='overlap') {
        const match=locateAnchor(stable,tail);
        if(typeof match!=='string') appended=stable.slice(match.index+tail.length).map(text=>({kind:'terminal',text}));
      } else if(classification==='initial') appended=stable.map(text=>({kind:'terminal',text}));
      else if(stable.length) appended=[{kind:'gap',text:'[history continuity unknown]'},...stable.map(text=>({kind:'terminal' as const,text}))];
      const raw=Buffer.from(JSON.stringify(o),'utf8');
      const batch={ticket,observation:o,appended,recordFrames:this.options.recordFrames??false,recordingSessionBytes:this.options.recordingSessionBytes,recordingRootBytes:this.options.recordingRootBytes,liveLineLimit:this.options.liveLineLimit??1000,
        evidence:{classification,depth,source:o.source,rawSha256:sha(raw)},unresolved:unresolved?raw:undefined};
      this.pending.set(sid,batch);
      const receipt=await this.commitBatch(batch);
      this.pending.delete(sid);
      // This is the sole delivery point. COMMIT has returned; a failed send cannot undo durability.
      await this.publish(receipt);
      return receipt;
    }catch(error){this.store.persistFault(sid,'capture-failed','completed probe within deadline',String(error));throw error;}
  }
  private async publish(receipt:CaptureReceipt):Promise<void> {
    try{await this.options.publish?.(receipt);}catch(error){this.store.persistFault(receipt.context.sessionId,'delivery-failed',receipt.context.revision,String(error));throw error;}
  }
  async stopAndDrain():Promise<void> {
    this.stopped=true;if(this.timer){clearInterval(this.timer);this.timer=null;}
    await Promise.allSettled(this.running.values());
    // Stop admission, but finish observations already accepted by this coordinator.
    for(const [sid,batch] of this.pending){await this.commitBatch(batch);this.pending.delete(sid);}
  }
}
