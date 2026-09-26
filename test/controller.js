// Mock-vscode activation test: start bridge, auto-tunnel (fake cloudflared), copy prompt.
const Module=require('module'),path=require('path'),fs=require('fs'),os=require('os');
const fake=path.join(os.tmpdir(),'fake-cloudflared');
fs.writeFileSync(fake,'#!/bin/sh\nif [ "$1" = --version ]; then echo "cloudflared version fake"; exit 0; fi\necho "args: $@" >&2\necho "https://fake-tunnel-name-here.trycloudflare.com" >&2\nsleep 30\n');fs.chmodSync(fake,0o755);
let clip='',msgs=[];const cmds={};
const cfg={cloudflaredPath:fake,autoTunnel:true};
const ws=fs.mkdtempSync(path.join(os.tmpdir(),'ws-'));
const disp={dispose(){}};
const vscode={
 workspace:{isTrusted:true,workspaceFolders:[{name:'ws',uri:{scheme:'file',fsPath:ws,toString:()=>ws}}],getConfiguration:()=>({get:(k,d)=>k in cfg?cfg[k]:d}),onDidChangeWorkspaceFolders:()=>disp,onDidChangeConfiguration:()=>disp},
 window:{createOutputChannel:()=>({appendLine(l){msgs.push(l)},append(l){msgs.push(l)},clear(){},dispose(){}}),createStatusBarItem:()=>({show(){},dispose(){}}),registerWebviewViewProvider:()=>disp,showInformationMessage:async m=>msgs.push(m),showErrorMessage:async m=>{console.error('ERR',m)},showWarningMessage:async()=>undefined},
 StatusBarAlignment:{Right:2},commands:{registerCommand:(n,f)=>(cmds[n]=f,disp),executeCommand:async()=>{}},
 env:{clipboard:{writeText:async t=>{clip=t}}},Uri:{file:p=>({fsPath:p,scheme:'file'})},languages:{getDiagnostics:()=>[]},
};
const o=Module._load;Module._load=function(r,...a){if(r==='vscode')return vscode;if(r==='node-pty')return{};return o.call(this,r,...a)};
const ext=require('../dist/extension.js');
(async()=>{
 ext.activate({subscriptions:[],extensionPath:path.join(__dirname,'..'),globalStorageUri:{fsPath:path.join(ws,'.st')},extension:{packageJSON:{version:'0.3.0'}}});
 await cmds['lanternBridge.start']();
 await cmds['lanternBridge.copyPrompt']();
 const line=msgs.find(m=>String(m).startsWith('[tunnel]'));
 console.log(line);
 console.log(clip.split('\n').slice(0,4).join('\n'));
 const ok=/--http-host-header localhost:\d+/.test(line)&&clip.includes('https://fake-tunnel-name-here.trycloudflare.com/mcp/');
 await ext.deactivate();console.log(ok?'CONTROLLER_OK':'CONTROLLER_FAIL');process.exit(ok?0:1);
})().catch(e=>{console.error(e);process.exit(1)});
