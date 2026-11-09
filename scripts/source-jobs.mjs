import { randomUUID } from 'node:crypto';

export function createSourceJobs(operations,root) {
  const jobs=new Map(); let activeId=null;
  return {
    active() { return activeId?jobs.get(activeId):null; },
    get(id) { return jobs.get(id) || null; },
    start(kind,collection) {
      if(this.active()?.status==='running')throw Error('다른 수집·갱신 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.');
      if(!['collect','refresh','apply'].includes(kind))throw Error('지원하지 않는 작업입니다.');
      const job={id:randomUUID(),kind,status:'running',startedAt:new Date().toISOString(),collection:collection||null,progress:{message:'공식 API 연결을 준비하고 있어요.',...(collection?{target:collection.target,requestLimit:collection.maxRequests}:{})},result:null,error:null};
      jobs.set(job.id,job); activeId=job.id;
      // Return immediately; status requests remain available during slow API calls.
      const args=kind==='collect'&&collection?[collection.target,{maxRequests:collection.maxRequests}]:[];
      Promise.resolve().then(()=>operations[kind](root,progress=>{job.progress={...job.progress,...progress};},...args)).then(result=>{
        job.status='complete';job.result=result;
      }).catch(error=>{job.status='failed';job.error=error.message;}).finally(()=>{
        job.finishedAt=new Date().toISOString(); if(activeId===job.id)activeId=null;
        if(jobs.size>20)jobs.delete(jobs.keys().next().value);
      });
      return job;
    },
  };
}
