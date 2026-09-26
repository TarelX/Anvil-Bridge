const Module=require('module');const o=Module._load;Module._load=function(r,...a){if(r==='node-pty')return {spawn(){throw Error('no pty')}};return o.call(this,r,...a)};
const vscode={workspace:{isTrusted:true,getConfiguration:()=>({get:(k,d)=>d})},Uri:{file:p=>({fsPath:p,scheme:'file'})},commands:{executeCommand:async()=>[]},languages:{getDiagnostics:()=>[]}};
const {Bridge}=require('../src/bridge');
(async()=>{const b=new Bridge(vscode,'/tmp/ws',{event:(...a)=>console.log('EV',...a),changed(){},accessState:()=>({mode:'full',revision:1,commands:true}),approve:async()=>({revision:1}),skillsDir:__dirname+"/../skills",storageDir:'/tmp/st',resultMode:()=>'text'});
await b.start(0);const url=b.url();console.log(url);
const H={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
let r=await fetch(url,{method:'POST',headers:H,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'t',version:'1'}}})});
const sid=r.headers.get('mcp-session-id');console.log(r.status,sid,(await r.text()).slice(0,80));
H['mcp-session-id']=sid;
await fetch(url,{method:'POST',headers:H,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
for(const [n,a] of [['list_directory',{path:'.'}],['read_files',{files:[{path:'a.txt'}]}],['run_command',{command:'echo hi',execution:'direct',background:false}]]){
 r=await fetch(url,{method:'POST',headers:H,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:n,arguments:a}})});console.log(n,(await r.text()).slice(0,260));}
await b.stop();process.exit(0)})().catch(e=>{console.error(e);process.exit(1)});
