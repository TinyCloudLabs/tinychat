import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { TinyCloudWeb } from '@tinycloud/web-sdk';
import { inventoryConnectorMeetings } from './connectorMigration';

function fixture(activated=false) {
 const db=new Database(':memory:');
 db.exec(`CREATE TABLE connector_meeting(id TEXT PRIMARY KEY,source TEXT,source_id TEXT,metadata TEXT${activated?',head_revision TEXT,publication_state TEXT,publication_unavailable_reason TEXT':''})`);
 const tcw={sql:{db:()=>({query:async(sql:string,params:any[]=[])=>{try { const query=db.query(sql);return {ok:true,data:{rows:query.values(...params)}};} catch(error) {return {ok:false,error:{code:'SQL',message:String(error)}};} }})},kv:{get:()=>{throw Error('Inventory must not read or rewrite unverified content');}}} as unknown as TinyCloudWeb;
 return {db,tcw};
}
test('inventory crosses 501, retains every ID and reports duplicate identities without merging',async()=>{
 const {db,tcw}=fixture();for(let n=0;n<603;n++)db.run('INSERT INTO connector_meeting VALUES(?,?,?,?)',[String(n).padStart(4,'0'),'google-meet',n===602?'source-0':`source-${n}`,JSON.stringify(n===501?{drive_file_id:'doc-501'}:{})]);
 const before=db.query('SELECT * FROM connector_meeting ORDER BY id').values();
 const result=await inventoryConnectorMeetings(tcw);
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.data.exhausted).toBe(true);expect(result.data.entries).toHaveLength(603);
 expect(result.data.entries.filter(x=>x.classification==='identity_collision').map(x=>x.meetingRef)).toEqual(['0000','0602']);
 expect(result.data.entries[501].documentIdCandidate).toBe('doc-501');
 expect(result.data.entries[1].originalStatus).toBe('not_verified');
 expect(db.query('SELECT * FROM connector_meeting ORDER BY id').values()).toEqual(before);
});
test('bounded inventory reports an unread cursor, while migrated and unavailable rows are separate',async()=>{
 const {db,tcw}=fixture(true);for(let n=0;n<102;n++)db.run('INSERT INTO connector_meeting VALUES(?,?,?,?,?,?,?)',[String(n).padStart(4,'0'),'fireflies',`source-${n}`,'{}',n===0?'a'.repeat(64):null,n===0?'published':'unavailable',n===0?null:'original_not_verified']);
 const result=await inventoryConnectorMeetings(tcw,{maxPages:1});expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.data.exhausted).toBe(false);expect(result.data.nextCursor).toBe('0099');expect(result.data.entries).toHaveLength(100);
 expect(result.data.entries[0].classification).toBe('published');expect(result.data.entries[1].classification).toBe('unavailable');
 expect(result.data.entries[1].reason).toBe('original_not_verified');expect(result.data.scope).toBe('observed');
});
