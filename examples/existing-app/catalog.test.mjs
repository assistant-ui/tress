import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resource } from "@assistant-ui/tap";
import { useStatewireState, useStatewireCommands } from "statewire/host";
import { StatewireHttp } from "statewire";
import { statewireHost } from "statewire-node";
import { Harness, HARNESS_THREADS_PROTOCOL } from "harness-sdk";
import { HARNESS_HOST_PROTOCOL } from "harness-sdk/host";
import { AISDKTransport } from "@harness-sdk/ai-sdk";
import { createUIMessageStream } from "ai";
const binary = process.env.TRESS_BIN ? resolve(process.env.TRESS_BIN) : fileURLToPath(new URL("../../target/debug/tress", import.meta.url));
async function until(check, label) {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
// A real PTY proves ordinary attach discovers threads without a local cache.
const pty = String.raw`
import os,pty,sys,select,errno,fcntl,termios,struct,signal
pid,master=pty.fork()
if pid==0: os.execv(sys.argv[1],sys.argv[1:])
signal.signal(signal.SIGTERM,lambda *_:os.kill(pid,signal.SIGTERM))
fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',30,110,0,0))
while True:
 ready,_,_=select.select([master,sys.stdin],[],[],15)
 if not ready: os.kill(pid,15); raise SystemExit('PTY timed out')
 if master in ready:
  try: data=os.read(master,65536)
  except OSError as e:
   if e.errno==errno.EIO: break
   raise
  if not data: break
  sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
 if sys.stdin in ready:
  data=os.read(sys.stdin.fileno(),65536)
  if data: os.write(master,data)
  else: os.kill(pid,15); break
_,status=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
test("ordinary attach discovers all allowed threads and continues existing browser conversations", {timeout:60_000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), "tress-catalog-"));
  const children = [], hosts = new Map(), browsers = [], errors = [];
  let server, origin, runs = 0, allowAnonymous = false, denyBeta = false;
  const entries = Array.from({length:25}, (_, i) => ({id:`thread-${i}`, title:`Browser conversation ${i}`, status:i===1?"archived":"regular", updatedAt:"2026-10-22T12:00:00.000Z"}));
  const other = [{id:"private-other",title:"OTHER USER PRIVATE TITLE",status:"regular",updatedAt:"2026-10-22T12:00:00.000Z"}];
  const lists = {};
  for (const [user, threads] of Object.entries({owner:entries, other})) {
    const Transport = resource(() => {
      const [state] = useStatewireState(() => ({threads}));
      lists[user] ??= {}; lists[user].state = state; return {state, commands:useStatewireCommands({})};
    });
    const host = statewireHost({protocol:HARNESS_THREADS_PROTOCOL,transport:Transport()});
    lists[user].host = host;
  }
  function threadHost(id) {
    if (!hosts.has(id)) hosts.set(id, statewireHost({key:[id],protocol:HARNESS_HOST_PROTOCOL,
      transport:AISDKTransport({threadId:id,transport:{
        async sendMessages({messages}) {
          runs++; const prompt = messages.at(-1).parts.filter(p=>p.type==="text").map(p=>p.text).join("");
          return createUIMessageStream({execute:async ({writer})=>{
            writer.write({type:"start",messageId:`reply-${runs}`});
            writer.write({type:"text-start",id:"text"});
            writer.write({type:"text-delta",id:"text",delta:`${id} reply: ${prompt}`});
            writer.write({type:"text-end",id:"text"});
            writer.write({type:"finish",finishReason:"stop"});
          }});
        }, async reconnectToStream(){return null;}
      }})}));
    return hosts.get(id);
  }
  t.after(async()=>{
    for (const child of children) if(child.exitCode===null) child.kill("SIGTERM");
    for (const browser of browsers) browser.dispose();
    if(server?.listening) server.closeAllConnections();
    for (const host of [...hosts.values(),...Object.values(lists).map(x=>x.host)]) await host.close();
    if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await rm(dir,{recursive:true,force:true});
  });
  server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,origin);
      const user=req.headers.authorization==="Bearer owner-key" || req.headers.cookie==="app=owner" || req.headers["x-app-auth"]==="custom-owner" ? "owner" : req.headers.authorization==="Bearer other-key" ? "other" : allowAnonymous && !req.headers.authorization ? "owner" : null;
      if(!user){res.writeHead(401).end("App credential required");return;}
      if(url.pathname==="/.well-known/tress.json") {res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({version:1,threads:"/api/thread-list",thread:"/api/threads/{id}"}));return;}
      let host;
      if(url.pathname.startsWith("/api/thread-list/")) host=lists[user].host;
      else {
        const id=url.pathname.match(/^\/api\/threads\/([^/]+)\/(stream|frames)$/)?.[1];
        if(!lists[user].state.threads.some(t=>t.id===id) || (denyBeta && id==="thread-1")){res.writeHead(403).end("Thread denied");return;}
        host=threadHost(id);
      }
      const abort=new AbortController();res.on("close",()=>abort.abort());
      const request=new Request(url,{method:req.method,headers:req.headers,signal:abort.signal,...(req.method==="POST"?{body:Readable.toWeb(req),duplex:"half"}:{})});
      const response=await host.fetch(request);res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body) Readable.fromWeb(response.body).on("error",()=>res.destroy()).pipe(res);else res.end();
    } catch(e){errors.push(e);if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${server.address().port}`;
  function cli(args, key="owner-key", terminal=false) {
    const child=spawn(terminal?"python3":binary,terminal?["-u","-c",pty,binary,...args]:args,{env:{...process.env,TRESS_TEST_APP_KEY:key,XDG_CONFIG_HOME:dir,XDG_STATE_HOME:dir,NO_COLOR:"1",TERM:"xterm-256color"},stdio:["pipe","pipe","pipe"]});
    children.push(child);let output="";child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>output+=b);
    return {child,output:()=>output,exited:once(child,"exit")};
  }
  for(const id of ["thread-0","thread-1"]) {
    const browser=new Harness({transport:StatewireHttp({url:`${origin}/api/threads/${id}`,fetch:(url,init={})=>{const headers=new Headers(init.headers);headers.set("Cookie","app=owner");return fetch(url,{...init,headers});}})});browsers.push(browser);
    await until(()=>browser.transport.status==="connected","browser attached");await browser.sendMessage(`original browser history ${id}`);
    await until(()=>!browser.isBusy && JSON.stringify(browser.messages).includes(`${id} reply:`),"browser saved history");
  }
  const auth=["--api-key-env","TRESS_TEST_APP_KEY"];
  const attached=cli(["attach",origin,...auth],"owner-key",true);
  await until(()=>attached.output().includes("Open thread number"),"automatic app thread picker").catch(e=>{console.error(attached.output());throw e;});
  assert.match(attached.output(),/Browser conversation 24/);assert.match(attached.output(),/Browser conversation 1 \[archived\]/);assert.doesNotMatch(attached.output(),/OTHER USER PRIVATE TITLE/);
  attached.child.stdin.write("1\n");
  await until(()=>attached.output().includes("thread-0 reply: original browser history thread-0"),"load existing history");
  attached.child.stdin.write("terminal continues existing browser thread\n");
  await until(()=>JSON.stringify(browsers[0].messages).includes("thread-0 reply: terminal continues"),"same host reply");
  attached.child.stdin.write("/thread thread-1\n");
  await until(()=>attached.output().includes("thread-1 reply: original browser history thread-1"),"switch to archived thread");
  attached.child.stdin.write("continue second thread\n");
  await until(()=>JSON.stringify(browsers[1].messages).includes("thread-1 reply: continue second thread"),"continue second history");
  lists.owner.state.threads=[...lists.owner.state.threads,{id:"new-browser-thread",title:"Created later in browser",status:"regular",updatedAt:"2026-10-22T13:00:00.000Z"}];
  attached.child.stdin.write("/threads\n");await until(()=>attached.output().includes("Created later in browser"),"refresh catalog");
  attached.child.stdin.write("/thread private-other\n");await until(()=>attached.output().includes("not in this application's accessible thread list"),"deny other user thread");
  attached.child.stdin.write("/attach\n");await until(()=>attached.output().includes(`tress attach ${origin}/ --api-key-env TRESS_TEST_APP_KEY`),"reusable connection command");
  assert.doesNotMatch(attached.output(),/owner-key/);
  attached.child.stdin.write("/exit\n");assert.equal((await attached.exited)[0],0,attached.output());assert.equal(runs,4);
  const lastBrowser=new Harness({transport:StatewireHttp({url:`${origin}/api/threads/new-browser-thread`,fetch:(url,init={})=>{const headers=new Headers(init.headers);headers.set("Cookie","app=owner");return fetch(url,{...init,headers});}})});browsers.push(lastBrowser);
  await until(()=>lastBrowser.transport.status==="connected","last browser attached");
  const ui=cli(["attach",origin,...auth,"--ui"],"owner-key",true);
  await until(()=>ui.output().includes("Open thread number"),"UI discovery");ui.child.stdin.write("1\n");
  await until(()=>ui.output().includes("\x1b[?1049h") && ui.output().includes("original browser history"),"terminal UI opened");
  ui.child.stdin.write("\x14");await until(()=>ui.output().includes("Threads"),"UI thread picker");
  ui.child.stdin.write("\x1b[B".repeat(25)+"\r");await until(()=>ui.output().includes("new-browser-thread"),"UI switched beyond recent limit");
  ui.child.stdin.write("UI continues the last listed thread\r");
  await until(()=>JSON.stringify(lastBrowser.messages).includes("new-browser-thread reply: UI continues"),"UI and browser share selected thread");
  ui.child.stdin.write("/exit\r");assert.equal((await ui.exited)[0],0,ui.output());
  const owner=cli(["threads",origin,...auth,"--json"]);assert.equal((await owner.exited)[0],0,owner.output());assert.equal(JSON.parse(owner.output()).threads.length,26);
  const foreign=cli(["threads",origin,...auth,"--json"],"other-key");assert.equal((await foreign.exited)[0],0,foreign.output());assert.deepEqual(JSON.parse(foreign.output()).threads.map(t=>t.id),["private-other"]);
  const denied=cli(["attach",origin,...auth],"wrong-key");assert.equal((await denied.exited)[0],1);assert.doesNotMatch(denied.output(),/Browser conversation|owner-key|wrong-key/);
  denyBeta=true;
  const revoked=cli(["threads",origin,...auth,"--open","thread-1"]);await until(()=>revoked.output().includes("Connection closed") || revoked.output().includes("Detached"),"per-thread rejection");assert.doesNotMatch(revoked.output(),/original browser history/);revoked.child.stdin.write("/exit\n");await revoked.exited;
  const file=join(dir,"custom.json");await writeFile(file,JSON.stringify({"X-App-Auth":"custom-owner"}),{mode:0o600});
  const custom=cli(["threads",origin,"--headers-file",file,"--json"]);assert.equal((await custom.exited)[0],0,custom.output());assert.equal(JSON.parse(custom.output()).threads.length,26);
  allowAnonymous=true;const anonymous=cli(["attach",origin]);assert.equal((await anonymous.exited)[0],0,anonymous.output());assert.match(anonymous.output(),/Browser conversation 24/);
  assert.equal(runs,5);assert.deepEqual(errors,[]);
});
