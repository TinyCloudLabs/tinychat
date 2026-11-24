import { expect, test } from "bun:test";
import { MeetingDesk } from "../meeting-reads";
import { botIdFor } from "../owner";
import { TELEGRAM_ERRORS } from "../telegram-tools";
const owner = `did:pkh:eip155:1:0x${'ab'.repeat(20)}`;
const bot = botIdFor(owner);
const conversation = 'c'.repeat(32);
test('Telegram area off returns fixed text without contacting backend', async () => {
  let called = false;
  const desk = new MeetingDesk({ backendOrigin:'https://api.test',backendCallSecret:'s'.repeat(48),fetch:async()=>{called=true; return Response.json({});} });
  expect(desk.handles('read_telegram_chat')).toBe(true);
  desk.push(bot,{owner,areas:[],conversation});
  expect((await desk.call(bot,'read_telegram_chat' as never,{chat:'a:1'})).content[0].text).toBe(TELEGRAM_ERRORS.off);
  expect(called).toBe(false);
});
test('Telegram shares owner-data wrapper and held mark with feed chats', async()=>{
  const desk = new MeetingDesk({backendOrigin:'https://api.test',backendCallSecret:'s'.repeat(48),fetch:async()=>Response.json({ok:true,text:JSON.stringify({messages:[{text:'synthetic message'}]})})});
  desk.push(bot,{owner,areas:['telegram' as never],conversation});
  expect(desk.tools(bot).map(tool=>tool.name)).toEqual(['list_telegram_chats','read_telegram_chat']);
  const result=await desk.call(bot,'read_telegram_chat' as never,{chat:'a:1'});
  expect(result.content[0].text).toContain('synthetic message');
  expect(result.content[0].text).toContain('OWNER DATA');
  expect(desk.held(bot)).toBe(true);
});
test('denied and not-ready replies use fixed Telegram copy',async()=>{
  for(const error of ['denied','not_ready'] as const){
    const desk=new MeetingDesk({backendOrigin:'https://api.test',backendCallSecret:'s'.repeat(48),fetch:async()=>Response.json({ok:false,error})});
    desk.push(bot,{owner,areas:['telegram' as never],conversation});
    const result=await desk.call(bot,'read_telegram_chat' as never,{chat:'a:1'});
    expect(result.content[0].text).toBe(TELEGRAM_ERRORS[error]);
    expect(desk.held(bot)).toBe(false);
  }
});

test('an oversized Telegram envelope is refused at the existing 64 KiB gateway bound',async()=>{
  const messages=Array.from({length:200},(_,i)=>({id:String(i+1),sender:'s'.repeat(300),time:1000+i,text:i===199?'last message marker':'',truncated:false}));
  const desk=new MeetingDesk({backendOrigin:'https://api.test',backendCallSecret:'s'.repeat(48),fetch:async()=>Response.json({ok:true,text:JSON.stringify({chat:'a:1',messages})})});
  desk.push(bot,{owner,areas:['telegram'],conversation});
  expect((await desk.call(bot,'read_telegram_chat',{chat:'a:1',limit:200})).content[0].text).toBe(TELEGRAM_ERRORS.unavailable);
});
