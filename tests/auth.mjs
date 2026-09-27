import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const dir=await mkdtemp(join(tmpdir(),'nursery-auth-')),key=randomBytes(32).toString('hex'),origin='http://localhost:3097';
const env={...process.env,NODE_ENV:'test',PORT:'3097',HOST:'127.0.0.1',PUBLIC_ORIGIN:origin,SETUP_KEY:key,DATA_DIR:dir,DISABLE_BACKUPS:'1'};
let child;async function start(){child=spawn(process.execPath,['server.mjs'],{env,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('start timeout')),10000);child.stdout.on('data',d=>{if(d.toString().includes('server ready')){clearTimeout(timeout);resolve()}});child.once('exit',c=>reject(Error('server exited '+c)))});}
async function stop(){if(!child||child.exitCode!==null)return;await new Promise(r=>{child.once('exit',r);child.kill('SIGTERM')});}
async function api(path,data,cookie,wrongOrigin){const r=await fetch(origin+'/api/'+path,{method:data?'POST':'GET',headers:{...(data?{'Content-Type':'application/json','Origin':wrongOrigin||origin}:{}),...(cookie?{Cookie:cookie}:{})},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
try{
 await start();assert.equal((await fetch(origin)).status,200);assert.equal((await api('ledger')).status,401);assert.equal((await api('auth')).data.setupRequired,true);
 assert.equal((await api('setup',{setupKey:'bad',username:'tamer',name:'تامر',password:'StrongTestPassword-123'})).status,403);
 let r=await api('setup',{setupKey:key,username:'tamer',name:'تامر',password:'StrongTestPassword-123'});assert.equal(r.status,201);let owner=r.cookie;
 assert.equal((await api('setup',{setupKey:key,username:'another',name:'آخر',password:'StrongTestPassword-123'})).status,409);
 assert.equal((await api('login',{username:'tamer',password:'wrong'})).status,401);
 assert.equal((await api('invite',{username:'fares',name:'فارس'},owner,'https://evil.invalid')).status,403);
 r=await api('invite',{username:'fares',name:'فارس ابو جاموس'},owner);assert.equal(r.status,201);const token=new URL(r.data.link).searchParams.get('invite');
 r=await api('accept-invite',{token,password:'PartnerPassword-123'});assert.equal(r.status,201);let partner=r.cookie;
 assert.equal((await api('accept-invite',{token,password:'PartnerPassword-123'})).status,400);
 assert.equal((await api('invite',{username:'third',name:'آخر'},partner)).status,403);
 r=await api('ledger');assert.equal(r.status,401);
 r=await api('ledger',undefined,owner);assert.equal(r.data.version,0);assert.equal(r.data.state.settings.name,'الأيادي الخضراء');
 r=await api('ledger',{version:0,action:'transaction',type:'capital',date:'2026-09-26',party:'1',amount:100000},owner);assert.equal(r.status,200);
 assert.equal((await api('ledger',undefined,partner)).data.state.transactions.length,1);
 assert.equal((await api('ledger',{version:0,action:'transaction',type:'capital',date:'2026-09-26',party:'2',amount:1000},partner)).status,409);
 await stop();await start();assert.equal((await api('ledger',undefined,partner)).data.state.transactions.length,1);
 r=await api('password',{current:'StrongTestPassword-123',password:'NewStrongPassword-123'},owner);assert.equal(r.status,200);const newOwner=r.cookie;assert.equal((await api('ledger',undefined,owner)).status,401);owner=newOwner;
 const id=(await api('users',undefined,owner)).data.users.find(u=>u.username==='fares').id;
 assert.equal((await api('revoke-user',{id},owner)).status,200);assert.equal((await api('ledger',undefined,partner)).status,401);
 assert.equal((await api('logout',{},owner)).status,200);assert.equal((await api('ledger',undefined,owner)).status,401);
 console.log('PASS: root page, protected data, setup secret and one-time setup, passwords, CSRF, invites, replay prevention, partner permissions, shared records, version conflicts, durable restart, password/session rotation, access revocation and logout.');
}finally{await stop();await rm(dir,{recursive:true,force:true})}
