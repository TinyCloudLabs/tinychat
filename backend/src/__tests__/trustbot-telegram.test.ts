import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { listTelegramChats, readTelegramChat, runTelegramTool, type TelegramPort } from "../trustbot-reads/telegram";

const opened: Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
const prefix = "xyz.tinycloud.inbox";
const account = "a".repeat(64);
const chat = `${account}:-123`;
const key = (n: number) => `${prefix}/media/${account}/bodies/${String(n).padStart(64, "0")}`;
function fixture() {
  const databases = new Map<string, Database>();
  for (const suffix of ["state", "main", "main-2"]) {
    const db = new Database(":memory:"); opened.push(db); databases.set(`${prefix}/db/${suffix}`, db);
    db.exec("CREATE TABLE chats(account_id TEXT, source_chat_id TEXT, kind TEXT, title TEXT, updated_at INTEGER); CREATE TABLE accounts(id TEXT,connector TEXT); CREATE TABLE participants(account_id TEXT,source_chat_id TEXT,source_participant_id TEXT,display_name TEXT,address TEXT,observed_at INTEGER); CREATE TABLE messages(account_id TEXT,source_chat_id TEXT,source_message_id TEXT,sender_id TEXT,direction TEXT,sent_at INTEGER,deleted_at INTEGER,expires_at INTEGER,body_kv_key TEXT)");
  }
  const state = databases.get(`${prefix}/db/state`)!;
  state.exec("CREATE TABLE inbox_shards(sequence INTEGER); INSERT INTO inbox_shards VALUES(1),(2)");
  state.run("INSERT INTO accounts VALUES(?, 'telegram')", [account]);
  state.run("INSERT INTO chats VALUES(?, '-123', 'supergroup', 'Project', 1)", [account]);
  state.run("INSERT INTO chats VALUES(?, '999', 'mail-thread', 'Mail secret', 2)", [account]);
  const main = databases.get(`${prefix}/db/main`)!;
  main.exec("CREATE TABLE layout_complete(id INTEGER,source TEXT); INSERT INTO layout_complete VALUES(1,'fresh')");
  const fetched: string[] = [];
  const queried: string[] = [];
  const bodies = new Map<string,string>();
  const port: TelegramPort = {
    async query(database, sql, params) { queried.push(database); return databases.get(database)!.query(sql).values(...params) as unknown[][]; },
    async get(key) { fetched.push(key); return bodies.get(key) ?? null; },
  };
  const add = (shard: number, id: string, sent: number, options: { deleted?: number; expires?: number; body?: string } = {}) => {
    const body = options.body ?? key(Number(id)); bodies.set(body, JSON.stringify({ text: `message ${id}`, content: { attachment: 'never read' } }));
    databases.get(`${prefix}/db/main${shard === 1 ? '' : `-${shard}`}`)!.run("INSERT INTO messages VALUES(?, '-123', ?, '42', 'incoming', ?, ?, ?, ?)", [account,id,sent,options.deleted ?? null,options.expires ?? null,body]);
  };
  return { port, add, fetched, queried, databases, main, state, bodies };
}

test("keyset pages merge all shards with numeric message-id ties", async () => {
  const f = fixture(); f.add(1,'9',300); f.add(2,'10',300); f.add(1,'8',200); f.add(2,'7',100);
  const first = await readTelegramChat(f.port,{chat,limit:2},new Set(),1000);
  expect(first.messages.map(m => m.id)).toEqual(['10','9']);
  const second = await readTelegramChat(f.port,{chat,before:first.before,limit:2},new Set(),1000);
  expect(second.messages.map(m => m.id)).toEqual(['8','7']);
  expect(second.before).toBeNull();
});
test("deleted and expired messages never fetch a body", async () => {
  const f = fixture(); f.add(1,'1',200,{deleted:1}); f.add(2,'2',300,{expires:1000}); f.add(2,'3',100,{expires:1001});
  expect((await readTelegramChat(f.port,{chat},new Set(),1000)).messages.map(m => m.text)).toEqual(['message 3']);
  expect(f.fetched).toEqual([key(3)]);
});
test("denied chat neither lists a title nor reads SQL or KV", async () => {
  const f = fixture(); f.add(1,'1',1);
  expect(await listTelegramChats(f.port,{},new Set([chat]))).toEqual({chats:[]});
  f.queried.length=0;
  await expect(readTelegramChat(f.port,{chat},new Set([chat]))).rejects.toMatchObject({code:'denied'});
  expect(f.queried).toEqual([]); expect(f.fetched).toEqual([]);
});
test("title-only listing excludes mail and never gets bodies", async () => {
  const f = fixture(); f.add(1,'1',1);
  expect((await listTelegramChats(f.port,{query:'Project'},new Set())).chats).toEqual([{chat,title:'Project'}]);
  expect((await listTelegramChats(f.port,{query:'message'},new Set())).chats).toEqual([]);
  await expect(readTelegramChat(f.port,{chat:`${account}:999`},new Set())).rejects.toMatchObject({code:'not_found'});
  expect(f.fetched).toEqual([]);
});
test("only exact body keys for the selected account can reach KV", async () => {
  const f = fixture(); f.add(1,'1',1,{body:`${prefix}/media/${account}/${'f'.repeat(64)}`});
  f.add(2,'2',2,{body:`${prefix}/sessions/token`}); f.add(2,'3',3,{body:`${prefix}/media/${'b'.repeat(64)}/bodies/${'f'.repeat(64)}`});
  const read = await readTelegramChat(f.port,{chat},new Set());
  expect(read.messages.every(m => m.text === null)).toBe(true); expect(f.fetched).toEqual([]);
});
test("sender fallback before participants and newest observed name after ingest", async () => {
  const f = fixture(); f.add(1,'1',1);
  expect((await readTelegramChat(f.port,{chat},new Set())).messages[0].sender).toBe('Telegram user 42');
  f.main.run("INSERT INTO participants VALUES(?, '-123','42','Old',NULL,1)",[account]);
  f.databases.get(`${prefix}/db/main-2`)!.run("INSERT INTO participants VALUES(?, '-123','42','New','@new',2)",[account]);
  expect((await readTelegramChat(f.port,{chat},new Set())).messages[0].sender).toBe('New (@new)');
});
test("layout marker gates content and invalid registries fail closed", async () => {
  const f=fixture(); f.main.exec('DELETE FROM layout_complete');
  await expect(readTelegramChat(f.port,{chat},new Set())).rejects.toMatchObject({code:'not_ready'});
  f.main.exec("INSERT INTO layout_complete VALUES(1,'fresh')"); f.state.exec('DELETE FROM inbox_shards WHERE sequence=1');
  await expect(readTelegramChat(f.port,{chat},new Set())).rejects.toMatchObject({code:'registry_invalid'});
});

test("the 200-message boundary retains a usable keyset cursor", async () => {
  const f = fixture();
  for (let id = 1; id <= 201; id++) f.add(id % 2 + 1, String(id), id);
  const first = await readTelegramChat(f.port, {chat, limit:200}, new Set());
  expect(first.messages[0].id).toBe("201"); expect(first.messages.at(-1)?.id).toBe("2");
  expect((await readTelegramChat(f.port, {chat, limit:200, before:first.before}, new Set())).messages.map(m=>m.id)).toEqual(["1"]);
  await expect(readTelegramChat(f.port, {chat, limit:201}, new Set())).rejects.toMatchObject({code:"invalid"});
});

test("non-user senders use their authoritative chat title but never a denied chat title", async () => {
  const f = fixture(); f.add(1, "1", 1);
  f.main.exec("UPDATE messages SET sender_id='chat:-123'");
  expect((await readTelegramChat(f.port, {chat}, new Set())).messages[0].sender).toBe("Project");
  f.state.run("INSERT INTO chats VALUES(?, '-456', 'channel', 'Denied sender title', 1)", [account]);
  f.main.exec("UPDATE messages SET sender_id='chat:-456'");
  expect((await readTelegramChat(f.port, {chat}, new Set([`${account}:-456`]))).messages[0].sender).not.toContain("Denied sender title");
});

test("long Unicode messages page within the 64 KiB gateway envelope without gaps or duplicates", async () => {
  const f = fixture();
  for (let id=1;id<=201;id++) {
    f.add(id%2+1,String(id),id);
    f.bodies.set(key(id),JSON.stringify({text:'"\\\\\\n😀'.repeat(2000),content:null}));
  }
  const seen:string[]=[]; let before:string|null=null;
  do {
    const page=await readTelegramChat(f.port,{chat,limit:200,...(before?{before}:{})},new Set());
    expect(Buffer.byteLength(JSON.stringify({ok:true,text:JSON.stringify(page)}))).toBeLessThanOrEqual(64*1024);
    if (!seen.length) { expect(page.before).not.toBeNull(); expect(page.messages.length).toBeLessThan(200); }
    expect(page.messages.every(message=>message.truncated && message.text?.includes("[message shortened]"))).toBe(true);
    seen.push(...page.messages.map(message=>message.id));before=page.before;
  } while(before);
  expect(seen).toEqual(Array.from({length:201},(_,i)=>String(201-i)));
});

test("a chat denied while its reads are in flight is withheld from the serialized answer", async () => {
  const f = fixture(); f.add(1, "1", 1);
  let deny!: () => void; const denied = new Set<string>();
  const paused = new Promise<void>(resolve => { deny = () => { denied.add(chat); resolve(); }; });
  const port: TelegramPort = { ...f.port, async get(key) { await paused; return f.port.get(key); } };
  const read = runTelegramTool("read_telegram_chat", { chat }, port, new Set(), async () => denied);
  deny();
  await expect(read).rejects.toMatchObject({ code: "not_found" });
  expect(JSON.parse(await runTelegramTool("list_telegram_chats", {}, f.port, new Set(), async () => denied)).chats).toEqual([]);
});
