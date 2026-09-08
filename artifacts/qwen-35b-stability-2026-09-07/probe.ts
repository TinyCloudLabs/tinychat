/** Explicit synthetic comparison; does not change the router or historical release evidence. */
import { appendFile, writeFile } from 'node:fs/promises';
const dir = new URL('.', import.meta.url);
const key = process.env.REDPILL_API_KEY;
if (!key) throw new Error('REDPILL_API_KEY is required');
const endpoint = 'https://api.redpill.ai/v1';
const models = ['qwen/qwen3.6-35b-a3b'];
const meetingPrompt = "From these meeting notes, return only JSON with keys actions (owner, task, due_date), pilot_target, pilot_confirmed, budget_approved, tentative_budget_eur, unresolved. Use null for unknown dates and YYYY-MM-DD for known dates. Include only explicitly committed actions. Notes recorded 2026-09-10: Maya: I will send the revised DPA to the vendor by September 12. Leo: I will finish SSO verification before the pilot, but I cannot commit to a date yet. Noor: An FAQ might help; let's decide next week who owns it. Maya: The pilot target is September 18, conditional on security approval. Leo: Security has not approved it yet. Maya: The budget is not approved; EUR 6,000 is only a tentative cap.";
const mathPrompt = 'Estimate our chat workload using only these rates. We will run 1200 meeting summaries, each using 8000 input tokens and 600 output tokens, at USD 0.40 per million input tokens and USD 1.60 per million output tokens. We will also run 800 Q&A turns, each using 1500 input tokens and 300 output tokens, at USD 0.20 per million input tokens and USD 0.80 per million output tokens. Total budget is USD 6; there are no other fees. Additional Q&A turns have the same token usage and rates. Do not round intermediate calculations. Return only JSON with summary_input_tokens, summary_output_tokens, qa_input_tokens, qa_output_tokens, summary_cost_usd, qa_cost_usd, total_cost_usd, remaining_budget_usd, maximum_additional_whole_qa_turns.';
const mathGold = {summary_input_tokens:9600000,summary_output_tokens:720000,qa_input_tokens:1200000,qa_output_tokens:240000,summary_cost_usd:4.992,qa_cost_usd:0.432,total_cost_usd:5.424,remaining_budget_usd:0.576,maximum_additional_whole_qa_turns:1066};
const toolDefinition = {type:'function',function:{name:'lookup_meeting',description:'Look up the recorded decision for one meeting ID. Use the returned facts when answering.',parameters:{type:'object',properties:{meeting_id:{type:'string'}},required:['meeting_id'],additionalProperties:false}}};
const toolPrompt = 'Use lookup_meeting to retrieve meeting M-204. Then return only JSON with decision_code, owner, due_date, approved, using the tool result exactly. Do not invent a decision before looking it up.';
const results:any[] = [];
const failures = new Map<string,number>();
const blockedUntil = new Map<string,number>();
const startedAt = new Date().toISOString();
let sequence = 0;
let wave = 1;
function parseAnswer(text:string):any {try{return JSON.parse(text.trim());}catch{return null;}}
function scoreMeeting(text:string) {
  const body = parseAnswer(text); const actions = body?.actions;
  const maya = Array.isArray(actions) ? actions.find((a:any)=>a.owner==='Maya') : null;
  const leo = Array.isArray(actions) ? actions.find((a:any)=>a.owner==='Leo') : null;
  const pending = JSON.stringify(body?.unresolved ?? '').toLowerCase();
  const slots = {json:body!==null,exactlyTwoActions:Array.isArray(actions)&&actions.length===2,mayaCommitment:!!maya&&/dpa/i.test(maya.task)&&maya.due_date==='2026-09-12',leoCommitment:!!leo&&/sso/i.test(leo.task)&&leo.due_date===null,pilotTarget:body?.pilot_target==='2026-09-18',pilotNotConfirmed:body?.pilot_confirmed===false,budgetNotApproved:body?.budget_approved===false,tentativeBudget:body?.tentative_budget_eur===6000,unresolvedSecurity:pending.includes('security'),unresolvedBudget:pending.includes('budget'),unresolvedFaq:pending.includes('faq'),unresolvedSso:pending.includes('sso')};
  return {pass:Object.values(slots).every(Boolean),slots,parsed:body};
}
function scoreMath(text:string) {
 const body = parseAnswer(text);
 const slots = Object.fromEntries(Object.entries(mathGold).map(([k,v])=>[k,typeof body?.[k]==='number'&&Math.abs(body[k]-v)<1e-6]));
 return {pass:Object.values(slots).every(Boolean),slots,parsed:body};
}
async function save(row:any) {
 results.push(row);
 await appendFile(new URL('results.jsonl',dir),JSON.stringify(row)+'\n');
 console.log(JSON.stringify({model:row.model,test:row.test,status:row.httpStatus,transport:row.transportPass,pass:row.assessment?.pass,durationMs:row.durationMs,firstContentMs:row.firstContentMs,error:row.error,skipped:row.skipped}));
}
async function request(model:string,test:string,messages:any[],extra:any={}) {
 const now=performance.now();
 const row:any={sequence:++sequence,model,test:'wave-'+wave+'/'+test,startedAt:new Date().toISOString(),request:{messages,...extra},httpStatus:null,transportPass:false,frames:0,firstEventMs:null,firstContentMs:null,firstToolMs:null,text:'',reasoningCharacters:0,done:false,finishReason:null,usage:null,calls:[]};
 const calls = new Map<number,any>();
 if ((failures.get(model)??0)>=2 || (blockedUntil.get(model)??0)>Date.now()) {row.skipped='Model stopped after two transport failures, or Retry-After has not elapsed';return row;}
 try {
  const res = await fetch(endpoint+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,messages,stream:true,stream_options:{include_usage:true},max_tokens:8192,...extra}),signal:AbortSignal.timeout(60_000)});
  row.httpStatus=res.status; row.headersMs=Math.round(performance.now()-now); row.retryAfter=res.headers.get('retry-after');
  if(!res.ok) {
   const body=await res.text();
   try {const parsed=JSON.parse(body);row.providerError={type:parsed.error?.type,code:parsed.error?.code,message:String(parsed.error?.message??'').slice(0,500)};}catch{row.providerError={message:'Non-JSON upstream error'};}
   if(row.retryAfter){const seconds=Number(row.retryAfter);const until=Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(row.retryAfter);if(Number.isFinite(until))blockedUntil.set(model,until);}
   throw new Error('HTTP '+res.status);
  }
  if(!res.headers.get('content-type')?.includes('text/event-stream')||!res.body)throw new Error('Expected SSE body');
  const decoder=new TextDecoder();let buffer='';
  function line(value:string){
   if(!value.startsWith('data:'))return;
   const data=value.slice(5).trim();if(data==='[DONE]'){row.done=true;return;}if(!data)return;
   const frame=JSON.parse(data);if(frame.error)throw new Error('SSE error: '+String(frame.error.code??frame.error.type??'unknown'));
   row.frames++;row.firstEventMs??=Math.round(performance.now()-now);row.returnedModel??=frame.model;
   if(frame.usage)row.usage=frame.usage;
   const choice=frame.choices?.[0];if(choice?.finish_reason)row.finishReason=choice.finish_reason;
   const delta=choice?.delta;
   if(delta?.content){row.firstContentMs??=Math.round(performance.now()-now);row.text+=delta.content;}
   row.reasoningCharacters+=(delta?.reasoning_content??delta?.reasoning??'').length;
   for(const part of delta?.tool_calls??[]){row.firstToolMs??=Math.round(performance.now()-now);const call=calls.get(part.index)??{id:'',type:'function',function:{name:'',arguments:''}};if(part.id)call.id=part.id;call.function.name+=part.function?.name??'';call.function.arguments+=part.function?.arguments??'';calls.set(part.index,call);}
  }
  for await (const bytes of res.body){buffer+=decoder.decode(bytes,{stream:true});let at;while((at=buffer.indexOf('\n'))>=0){line(buffer.slice(0,at).trim());buffer=buffer.slice(at+1);}}
  buffer+=decoder.decode();if(buffer.trim())line(buffer.trim());
  row.calls=[...calls.values()];
  if(!row.done||!row.frames)throw new Error('Incomplete SSE stream');
  if(row.finishReason==='length')throw new Error('Output token limit reached');
  if(!row.text&&!row.calls.length)throw new Error('No visible answer or tool call');
  row.transportPass=true;
 } catch(error) {
  row.error=String(error).replaceAll(key!,'[REDACTED]');failures.set(model,(failures.get(model)??0)+1);
 }
 row.durationMs=Math.round(performance.now()-now);return row;
}
async function runRound(name:string,handler:(model:string)=>Promise<void>,round:number) {
 const offset=(round*2)%models.length;const order=[...models.slice(offset),...models.slice(0,offset)];
 console.log('ROUND '+name);
 for (const model of order) await handler(model);
}
await writeFile(new URL('results.jsonl',dir),'');
await writeFile(new URL('method.json',dir),JSON.stringify({startedAt,endpoint,models,requestsPerModel:12,waves:2,interWavePauseMs:30000,maxConcurrency:1,requestTimeoutMs:60000,maxTokens:8192,defaultSampling:true,synthesisReasoningEffort:'low',circuitBreaker:'Stop after two transport failures for a model; honor Retry-After. No immediate retries.',meetingPrompt,mathPrompt,mathGold,toolPrompt,notes:['Synthetic public fixtures only; no user conversations.','First content time measures visible text, not hidden reasoning.','Transport success and exact fixture correctness are reported separately.','These short samples cannot establish long-term reliability or broad quality ranking.','Provider telemetry and price claims are snapshots, not measured request success.','Tools simulate a local lookup; this does not validate live Eliza authorization or dispatch.','No per-response attestation verification or large-context tests.']},null,2)+'\n');
for (wave = 1; wave <= 2; wave++) {
 console.log('WAVE '+wave);
await runRound('tool',async model=>{
 const messages:any[]=[{role:'user',content:toolPrompt}];const r=await request(model,'tool-call',messages,{tools:[toolDefinition],tool_choice:'auto'});
 const call=r.calls[0];let args:any=null;try{args=JSON.parse(call?.function.arguments);}catch{}
 r.assessment={pass:r.transportPass&&r.calls.length===1&&!!call.id&&call.function.name==='lookup_meeting'&&args?.meeting_id==='M-204'&&Object.keys(args).length===1};await save(r);
 if(!r.assessment.pass)return;
 const gold={decision_code:'pilot-'+crypto.randomUUID(),owner:'Maya',due_date:'2026-09-18',approved:false};
 messages.push({role:'assistant',content:r.text||null,tool_calls:r.calls},{role:'tool',tool_call_id:call.id,content:JSON.stringify(gold)});
 const s=await request(model,'tool-result',messages,{tools:[toolDefinition],tool_choice:'auto',reasoning_effort:'low'});
 const body=parseAnswer(s.text);s.assessment={pass:s.transportPass&&s.calls.length===0&&Object.entries(gold).every(([k,v])=>body?.[k]===v),expected:gold,parsed:body};await save(s);
},3);
await runRound('short-reply-1',async model=>{const r=await request(model,'short-reply-1',[{role:'user',content:'Reply exactly READY_731_'+wave+' and nothing else.'}]);r.assessment={pass:r.transportPass&&r.text.trim()==='READY_731_'+wave};await save(r);},0);
await runRound('meeting',async model=>{const r=await request(model,'meeting',[{role:'user',content:meetingPrompt}]);r.assessment=scoreMeeting(r.text);r.assessment.pass&&=r.transportPass;await save(r);},1);
await runRound('budget',async model=>{const r=await request(model,'budget',[{role:'user',content:mathPrompt}]);r.assessment=scoreMath(r.text);r.assessment.pass&&=r.transportPass;await save(r);},2);
await runRound('short-reply-2',async model=>{const r=await request(model,'short-reply-2',[{role:'user',content:'Reply exactly READY_946_'+wave+' and nothing else.'}]);r.assessment={pass:r.transportPass&&r.text.trim()==='READY_946_'+wave};await save(r);},4);
 if ((failures.get(models[0]) ?? 0) >= 2) break;
 if (wave < 2) { console.log('INTER-WAVE PAUSE 30s'); await Bun.sleep(30_000); }
}
await writeFile(new URL('results.json',dir),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),endpoint,results},null,2)+'\n');
console.log('FINISHED '+new URL('results.json',dir).pathname);
