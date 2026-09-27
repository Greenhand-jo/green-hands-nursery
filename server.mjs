import http from 'node:http';
import {DatabaseSync,backup} from 'node:sqlite';
import {scrypt as rawScrypt,randomBytes,createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdirSync,readFileSync,existsSync,statSync,readdirSync,unlinkSync} from 'node:fs';
import {resolve,extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {apply,initial} from './lib/ledger.ts';
const scrypt=promisify(rawScrypt),root=fileURLToPath(new URL('.',import.meta.url));
const dataDir=resolve(process.env.DATA_DIR||join(root,'data'));mkdirSync(dataDir,{recursive:true});
const db=new DatabaseSync(join(dataDir,'nursery.sqlite'));db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','partner')));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,username TEXT NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,data TEXT NOT NULL);`);
db.prepare('INSERT OR IGNORE INTO ledger VALUES (1,0,?)').run(JSON.stringify(initial()));
const production=process.env.NODE_ENV==='production';
const origin=process.env.PUBLIC_ORIGIN?.replace(/\/$/,'');
const hash=v=>createHash('sha256').update(v).digest('hex');
const safeEq=(a,b)=>timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
const send=(res,status,obj,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});res.end(JSON.stringify(obj));};
function rate(key,max){const now=Date.now();db.prepare('DELETE FROM rate_limits WHERE expires<?').run(now);const r=db.prepare('SELECT count FROM rate_limits WHERE key=?').get(key);if(r&&r.count>=max)throw Object.assign(Error('محاولات كثيرة. حاول بعد 15 دقيقة.'),{status:429});db.prepare('INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+15*60*1000);}
function username(v){if(typeof v!=='string'||! /^[a-z0-9._-]{3,40}$/i.test(v))throw Error('اسم الدخول: 3–40 حرفاً إنجليزياً أو رقماً أو نقطة أو شرطة');return v.toLowerCase();}
function password(v){if(typeof v!=='string'||v.length<12||v.length>128)throw Error('كلمة المرور يجب أن تكون من 12 إلى 128 حرفاً');return v;}
function name(v){if(typeof v!=='string'||!v.trim()||v.length>100)throw Error('أدخل الاسم');return v.trim();}
async function encode(v){const salt=randomBytes(16).toString('hex');return salt+':'+Buffer.from(await scrypt(password(v),salt,64)).toString('hex');}
async function verify(v,p){const [salt,value]=p.split(':');const got=Buffer.from(await scrypt(String(v||'').slice(0,128),salt,64));return got.length===value.length/2&&timingSafeEqual(got,Buffer.from(value,'hex'));}
const cookie=(token,age)=>`nursery_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${production?'; Secure':''}`;
function issueSession(u,res){const token=randomBytes(32).toString('base64url');db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token),u.id,Date.now()+12*3600000);res.setHeader('Set-Cookie',cookie(token,43200));}
function session(req){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('nursery_session='))?.slice(16);if(!token)return null;return db.prepare('SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(hash(token),Date.now())||null;}
function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e;}}
async function body(req){let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>120000)throw Error('حجم الطلب أكبر من المسموح');}return JSON.parse(data||'{}');}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
 try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/healthz')return send(res,200,{ok:!!db.prepare('SELECT 1').get()});
 if(path.startsWith('/api/')){
 const method=req.method;if(!['GET','POST'].includes(method))return send(res,405,{error:'طريقة غير مسموحة'});
 if(method==='POST'){
 const allowed=origin||(!production?`http://localhost:${process.env.PORT||3000}`:null);
 if(!allowed||req.headers.origin!==allowed)return send(res,403,{error:'مصدر الطلب غير مسموح؛ تحقق من عنوان البرنامج'});
 if(!req.headers['content-type']?.startsWith('application/json'))return send(res,415,{error:'صيغة غير مسموحة'});
 }
 const u=session(req),a=method==='POST'?await body(req):null;
 if(path==='/api/auth'&&method==='GET')return send(res,200,{user:u,setupRequired:!db.prepare('SELECT 1 FROM users LIMIT 1').get()});
 if(['/api/setup','/api/login','/api/accept-invite'].includes(path)&&method==='POST'){
 rate('ip:'+req.socket.remoteAddress,40);
 if(path==='/api/setup'){
 if(db.prepare('SELECT 1 FROM users LIMIT 1').get())return send(res,409,{error:'تم إنشاء حساب المدير مسبقاً'});
 if(!process.env.SETUP_KEY||!safeEq(String(a.setupKey||''),process.env.SETUP_KEY))return send(res,403,{error:'رمز التهيئة غير صحيح'});
 const user={id:randomUUID(),username:username(a.username),name:name(a.name),role:'owner'},pw=await encode(a.password);
 transaction(()=>{if(db.prepare('SELECT 1 FROM users LIMIT 1').get())throw Error('تم الإعداد مسبقاً');db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id,user.username,user.name,pw,user.role)});issueSession(user,res);return send(res,201,{user});
 }
 if(path==='/api/login'){
 const un=username(a.username);rate('user:'+un,8);const user=db.prepare('SELECT * FROM users WHERE username=?').get(un);
 // A fixed dummy hash retains a password derivation on unknown accounts.
 const dummy='00000000000000000000000000000000:'+ '00'.repeat(64);
 const correct=await verify(a.password,user?.password||dummy);if(!user||!correct)return send(res,401,{error:'اسم الدخول أو كلمة المرور غير صحيحة'});
 db.prepare('DELETE FROM rate_limits WHERE key=?').run('user:'+un);issueSession(user,res);return send(res,200,{user:{id:user.id,username:user.username,name:user.name,role:user.role}});
 }
 const token=hash(String(a.token||''));const invite=db.prepare('SELECT * FROM invites WHERE token=? AND expires>?').get(token,Date.now());if(!invite)return send(res,400,{error:'الدعوة غير صالحة أو انتهت مدتها'});
 const pw=await encode(a.password),user={id:randomUUID(),username:invite.username,name:invite.name,role:'partner'};
 transaction(()=>{const used=db.prepare('DELETE FROM invites WHERE token=? AND expires>?').run(token,Date.now());if(used.changes!==1)throw Error('الدعوة مستخدمة');db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id,user.username,user.name,pw,user.role)});issueSession(user,res);return send(res,201,{user});
 }
 if(!u)return send(res,401,{error:'يرجى تسجيل الدخول'});
 if(path==='/api/logout'&&method==='POST'){db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);res.setHeader('Set-Cookie',cookie('',0));return send(res,200,{ok:true});}
 if(path==='/api/password'&&method==='POST'){
 rate('password:'+u.id,8);const user=db.prepare('SELECT password FROM users WHERE id=?').get(u.id);if(!await verify(a.current,user.password))return send(res,400,{error:'كلمة المرور الحالية غير صحيحة'});const pw=await encode(a.password);transaction(()=>{db.prepare('UPDATE users SET password=? WHERE id=?').run(pw,u.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id)});issueSession(u,res);return send(res,200,{ok:true});
 }
 if(path==='/api/invite'&&method==='POST'){
 if(u.role!=='owner')return send(res,403,{error:'إضافة المستخدمين متاحة للمدير فقط'});
 const un=username(a.username),nm=name(a.name);if(db.prepare('SELECT 1 FROM users WHERE username=?').get(un))return send(res,409,{error:'اسم الدخول مستخدم'});
 const token=randomBytes(32).toString('base64url');transaction(()=>{db.prepare('DELETE FROM invites WHERE username=? OR expires<?').run(un,Date.now());db.prepare('INSERT INTO invites VALUES (?,?,?,?)').run(hash(token),un,nm,Date.now()+24*3600000)});return send(res,201,{link:`${origin||req.headers.origin}/?invite=${token}`,username:un,expiresHours:24});
 }
 if(path==='/api/users'&&method==='GET'){if(u.role!=='owner')return send(res,403,{error:'غير مسموح'});return send(res,200,{users:db.prepare('SELECT id,username,name,role FROM users').all()});}
 if(path==='/api/revoke-user'&&method==='POST'){
 if(u.role!=='owner'||a.id===u.id)return send(res,403,{error:'غير مسموح'});
 transaction(()=>{db.prepare('DELETE FROM sessions WHERE user_id=?').run(a.id);db.prepare('DELETE FROM users WHERE id=? AND role=?').run(a.id,'partner')});return send(res,200,{ok:true});
 }
 if(path==='/api/ledger'){
 if(method==='GET'){const r=db.prepare('SELECT version,data FROM ledger WHERE id=1').get();return send(res,200,{version:r.version,state:JSON.parse(r.data)});}
 const result=transaction(()=>{const r=db.prepare('SELECT version,data FROM ledger WHERE id=1').get();if(r.version!==a.version)throw Object.assign(Error('تم تعديل البيانات. حدّث الصفحة ثم أعد المحاولة.'),{status:409});const state=apply(JSON.parse(r.data),a,u.username);db.prepare('UPDATE ledger SET version=version+1,data=? WHERE id=1').run(JSON.stringify(state));return {state,version:r.version+1};});return send(res,200,result);
 }
 return send(res,404,{error:'الطلب غير موجود'});
 }
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}
 const clean=decodeURIComponent(path);let file=resolve(root,'dist','.'+(clean==='/'?'/index.html':clean));const base=resolve(root,'dist')+'/';if(!file.startsWith(base)){res.writeHead(403);return res.end();}
 if(!existsSync(file)||!statSync(file).isFile()){if(extname(clean)){res.writeHead(404);return res.end();}file=join(root,'dist/index.html');}
 const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
 res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':extname(file)==='.html'?'no-cache':'public, max-age=3600'});res.end(req.method==='HEAD'?undefined:readFileSync(file));
 }catch(e){const expected=!!e.status||e.code==='SQLITE_CONSTRAINT_UNIQUE';send(res,e.status||400,{error:e.code==='SQLITE_CONSTRAINT_UNIQUE'?'اسم الدخول مستخدم':e.message||'تعذر تنفيذ الطلب'});}
});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log('Nursery server ready'));
let backingUp=false;
async function dailyBackup(){if(backingUp)return;backingUp=true;try{const dir=join(dataDir,'backups');mkdirSync(dir,{recursive:true});const date=new Date().toISOString().slice(0,10),file=join(dir,date+'.sqlite');if(!existsSync(file))await backup(db,file);const files=readdirSync(dir).filter(x=>/^\d{4}-\d{2}-\d{2}\.sqlite$/.test(x)).sort();for(const old of files.slice(0,-7))unlinkSync(join(dir,old));}catch{console.error('Daily backup failed; check storage capacity')}finally{backingUp=false}}
if(process.env.DISABLE_BACKUPS!=='1'){void dailyBackup();setInterval(dailyBackup,3600000).unref();}
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>server.close(()=>{db.close();process.exit(0)}));
