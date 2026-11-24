import { expect, test } from 'bun:test';
import { changeReadArea, type ReadSettings, type ReadAreaApi } from './trustbotReadGrant';
const saved: ReadSettings = {serviceDid:'did:pkh:eip155:1:0x'+'11'.repeat(20),expiresAt:1000,grantCid:'primary',areas:{meetings:'on',feed_chats:'off',telegram:'on'},telegramGrantCid:'telegram-old',telegramExpiresAt:2000} as ReadSettings;
function api(){
  const revoked:string[]=[]; const signed:string[][]=[];
  const port:ReadAreaApi={readSettings:async()=>saved,signReadGrant:async(_did,areas)=>{signed.push(areas);return{serialized:'s',siwe:'w',signature:'g'};},revokeReadGrant:async cid=>{revoked.push(cid);},setReadArea:async(area,enabled)=>({...saved,areas:{...saved.areas,[area]:enabled?'on':'off'},telegramGrantCid:area==='telegram'?'telegram-new':saved.telegramGrantCid,grantCid:area==='telegram'?'primary':'primary-new'})};
  return {port,revoked,signed};
}
test('Telegram enable replaces only its own grant',async()=>{
  const f=api();const result=await changeReadArea(f.port,saved,'telegram' as never,true);
  expect(f.signed).toEqual([['telegram']]);expect(f.revoked).toEqual(['telegram-old']);expect(result.grantCid).toBe('primary');
});
test('Telegram off revokes only Telegram and other areas leave Telegram alone',async()=>{
  const f=api();await changeReadArea(f.port,saved,'telegram' as never,false);expect(f.revoked).toEqual(['telegram-old']);
  const g=api();await changeReadArea(g.port,saved,'meetings',false);expect(g.revoked).toEqual(['primary']);
  const h=api();await changeReadArea(h.port,saved,'feed_chats',true);expect(h.signed).toEqual([['meetings','feed_chats']]);expect(h.revoked).toEqual(['primary']);
});
