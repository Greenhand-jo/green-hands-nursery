export type Product={id:string;name:string;unit:string;price:number;min:number;qty:number;value:number};
export type Contact={id:string;name:string;phone:string;kind:string};
export type Entry={account:string;debit:number;credit:number};
export type Batch={id:string;name:string;product:string;planned:number;good:number;cost:number;status:'growing'|'done';date:string;finished?:string};
export type Tx={id:string;seq:number;type:string;date:string;note:string;party:string;total:number;paid:number;lines:any[];entries:Entry[];voided?:boolean;reverses?:string;actor:string;created:string;before?:Product[];batchId?:string;batchBefore?:Batch|null};
export type State={settings:{name:string;p1:string;p2:string;share:number;phone:string};batches:Batch[];products:Product[];contacts:Contact[];transactions:Tx[];audit:any[]};
export const initial=():State=>({settings:{name:'الأيادي الخضراء',p1:'تامر',p2:'فارس ابو جاموس',share:50,phone:''},batches:[],products:[],contacts:[],transactions:[],audit:[]});
export const labels:Record<string,string>={sale:'فاتورة بيع',purchase:'فاتورة شراء',expense:'مصروف',receipt:'سند قبض',payment:'سند دفع',capital:'إيداع شريك',drawing:'سحب شريك',opening:'مخزون افتتاحي',waste:'تالف مخزون',reversal:'عكس قيد',production_start:'بدء دفعة إنتاج',production_cost:'تكلفة دفعة إنتاج',production_finish:'إكمال دفعة إنتاج'};
export function balances(s:State){const b:Record<string,number>={};for(const t of s.transactions)for(const e of t.entries)b[e.account]=(b[e.account]||0)+e.debit-e.credit;return b;}
function fail(s:string):never{throw new Error(s)}
const text=(v:any,max=160)=>typeof v==='string'&&v.trim()&&v.length<=max?v.trim():fail('يرجى إدخال نص صحيح');
const num=(v:any,min=0,max=1e11)=>Number.isSafeInteger(v)&&v>=min&&v<=max?v:fail('قيمة رقمية غير صحيحة');
export function apply(s:State,a:any,actor:string):State{
 const next=structuredClone(s), id=crypto.randomUUID();next.batches ||= [];
 if(a.action==='settings'){next.settings={name:text(a.name),p1:text(a.p1),p2:text(a.p2),share:num(a.share,0,100),phone:String(a.phone||'').slice(0,40)};}
 else if(a.action==='product'){const old=next.products.find(p=>p.id===a.id);const p={id:old?.id||id,name:text(a.name),unit:text(a.unit,40),price:num(a.price),min:num(a.min),qty:old?.qty||0,value:old?.value||0};if(old)Object.assign(old,p);else next.products.push(p);}
 else if(a.action==='contact'){if(!['customer','supplier'].includes(a.kind))fail('نوع جهة غير صحيح');const old=next.contacts.find(c=>c.id===a.id);if(old&&old.kind!==a.kind&&next.transactions.some(t=>t.party===old.id))fail('لا يمكن تغيير نوع جهة مرتبطة بحركات؛ أضف جهة جديدة');const c={id:old?.id||id,name:text(a.name),phone:String(a.phone||'').slice(0,40),kind:a.kind};if(old)Object.assign(old,c);else next.contacts.push(c);}
 else if(a.action==='reverse'){
 const last=next.transactions.filter(t=>!t.voided&&t.type!=='reversal').at(-1);if(!last||last.id!==a.id)fail('يمكن عكس آخر حركة فعالة فقط لحماية تكلفة المخزون. اعكس الحركات الأحدث أولاً.');
 last.voided=true;if(last.before)for(const p of last.before){const cur=next.products.find(v=>v.id===p.id)!;cur.qty=p.qty;cur.value=p.value;}
 if(last.batchId){next.batches=next.batches.filter(x=>x.id!==last.batchId);if(last.batchBefore)next.batches.push(structuredClone(last.batchBefore));}
 next.transactions.push({...last,id,seq:next.transactions.length+1,type:'reversal',voided:false,reverses:last.id,note:text(a.note),created:new Date().toISOString(),actor,entries:last.entries.map(e=>({...e,debit:e.credit,credit:e.debit})),before:undefined});
 }else if(a.action==='transaction'){
 if(!labels[a.type]||a.type==='reversal')fail('نوع حركة غير صحيح');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(a.date)||Number.isNaN(Date.parse(a.date))||new Date(a.date).toISOString().slice(0,10)!==a.date)fail('التاريخ غير صحيح');
 const last=next.transactions.filter(t=>!t.voided&&t.type!=='reversal').at(-1);if(last&&a.date<last.date)fail('سجل الحركات بترتيب تاريخي؛ التاريخ أقدم من آخر حركة');
 const t:Tx={id,seq:next.transactions.length+1,type:a.type,date:a.date,note:String(a.note||'').slice(0,500),party:String(a.party||''),total:0,paid:0,lines:[],entries:[],actor,created:new Date().toISOString(),before:[]};
 const b=balances(next);const post=(account:string,debit:number,credit:number)=>{if(debit||credit)t.entries.push({account,debit,credit});};
 if(['production_start','production_cost','production_finish'].includes(a.type)){
 let batch:Batch;
 if(a.type==='production_start'){
 const output=next.products.find(p=>p.id===a.product);if(!output)fail('اختر صنف الشتلات الناتجة');
 batch={id,name:text(a.name),product:output.id,planned:num(a.planned,1,1e7),good:0,cost:0,status:'growing',date:a.date};
 t.batchId=id;t.batchBefore=null;next.batches.push(batch);
 }else{
 const found=next.batches.find(x=>x.id===a.batchId);if(!found||found.status!=='growing')fail('الدفعة غير موجودة أو مكتملة');
 batch=found;t.batchId=batch.id;t.batchBefore=structuredClone(batch);
 }
 t.note=batch.name+(t.note?' — '+t.note:'');
 if(a.type==='production_finish'){
 const good=num(a.good,0,batch.planned),out=next.products.find(p=>p.id===batch.product);if(!out)fail('صنف الناتج غير موجود');
 t.total=batch.cost;batch.good=good;batch.status='done';batch.finished=a.date;
 if(good>0){t.before!.push({...out});out.qty+=good;out.value+=batch.cost;t.lines.push({product:out.id,name:out.name,unit:out.unit,qty:good,price:batch.cost/good,value:batch.cost});post('inventory',batch.cost,0);}
 else post('waste',batch.cost,0);
 post('wip',0,batch.cost);
 }else{
 const extra=num(a.amount||0);if(!Array.isArray(a.lines)||a.lines.length>80)fail('مواد الدفعة غير صحيحة');const seen=new Set();let materials=0;
 for(const l of a.lines){const p=next.products.find(p=>p.id===l.product);if(!p||seen.has(p.id)||p.id===batch.product)fail('مادة مكررة أو غير صحيحة؛ افصل المواد عن صنف الناتج');seen.add(p.id);const q=num(l.qty,1,1e7);if(q>p.qty)fail('المخزون غير كافٍ: '+p.name);t.before!.push({...p});const v=q===p.qty?p.value:Math.round(p.value*q/p.qty);p.qty-=q;p.value-=v;materials+=v;t.lines.push({product:p.id,name:p.name,unit:p.unit,qty:q,price:v/q,value:v});}
 t.total=materials+extra;num(t.total);if(a.type==='production_cost'&&t.total===0)fail('أدخل مواد أو تكلفة إضافية');t.paid=extra;batch.cost+=t.total;post('wip',t.total,0);post('inventory',0,materials);post('cash',0,extra);
 }
 }else if(['sale','purchase','opening','waste'].includes(a.type)){
 if(!Array.isArray(a.lines)||!a.lines.length||a.lines.length>80)fail('أضف صنفاً واحداً على الأقل');let cost=0;const seen=new Set();
 for(const l of a.lines){const p=next.products.find(p=>p.id===l.product);if(!p||seen.has(p.id))fail('صنف مفقود أو مكرر');seen.add(p.id);const q=num(l.qty,1,1e7);const price=num(l.price);t.before!.push({...p});let value=0;
 if(a.type==='sale'||a.type==='waste'){if(q>p.qty)fail('الكمية غير كافية: '+p.name);value=q===p.qty?p.value:Math.round(p.value*q/p.qty);p.qty-=q;p.value-=value;cost+=value;}else{value=q*price;num(value);p.qty+=q;p.value+=value;}
 t.lines.push({product:p.id,name:p.name,unit:p.unit,qty:q,price,value});t.total+=a.type==='waste'?value:q*price;}
 num(t.total);const paid=a.type==='sale'||a.type==='purchase'?num(a.paid,0,t.total):0;t.paid=paid;
 const c=next.contacts.find(c=>c.id===t.party);if((a.type==='sale'||a.type==='purchase')&&(t.total>paid||t.party)&&(!c||c.kind!==(a.type==='sale'?'customer':'supplier')))fail('اختر العميل أو المورد المناسب للحركة');
 if(a.type==='sale'){post('cash',paid,0);post('ar:'+t.party,t.total-paid,0);post('sales',0,t.total);post('cogs',cost,0);post('inventory',0,cost);}
 if(a.type==='purchase'){post('inventory',t.total,0);post('cash',0,paid);post('ap:'+t.party,0,t.total-paid);}
 if(a.type==='opening'){post('inventory',t.total,0);post('opening',0,t.total);}
 if(a.type==='waste'){post('waste',cost,0);post('inventory',0,cost);}
 }else{
 t.total=num(a.amount,1);t.paid=t.total;
 if(['capital','drawing'].includes(a.type)&&!['1','2'].includes(t.party))fail('اختر الشريك');
 if(a.type==='expense'){t.note=text(a.note,500);post('expense',t.total,0);post('cash',0,t.total);}
 if(a.type==='capital'){post('cash',t.total,0);post('capital:'+t.party,0,t.total);}
 if(a.type==='drawing'){post('drawing:'+t.party,t.total,0);post('cash',0,t.total);}
 if(a.type==='receipt'){const c=next.contacts.find(c=>c.id===t.party&&c.kind==='customer');if(!c||t.total>(b['ar:'+t.party]||0))fail('المبلغ أكبر من ذمة العميل');post('cash',t.total,0);post('ar:'+t.party,0,t.total);}
 if(a.type==='payment'){const c=next.contacts.find(c=>c.id===t.party&&c.kind==='supplier');if(!c||t.total>-(b['ap:'+t.party]||0))fail('المبلغ أكبر من ذمة المورد');post('ap:'+t.party,t.total,0);post('cash',0,t.total);}
 }
 if(t.entries.reduce((v,e)=>v+e.debit-e.credit,0)!==0)fail('القيد غير متوازن');
 const cash=(b.cash||0)+t.entries.filter(e=>e.account==='cash').reduce((v,e)=>v+e.debit-e.credit,0);if(cash<0)fail('رصيد الصندوق غير كافٍ. سجل التمويل أو الرصيد الافتتاحي أولاً.');
 next.transactions.push(t);
 }else fail('عملية غير معروفة');
 const bal=balances(next);if((bal.cash||0)<0)fail('العكس ينتج صندوقاً سالباً');
 if(next.products.reduce((v,p)=>v+p.value,0)!==(bal.inventory||0))fail('رصيد المخزون غير متطابق');
 if(next.batches.filter(x=>x.status==='growing').reduce((v,x)=>v+x.cost,0)!==(bal.wip||0))fail('تكلفة الإنتاج قيد التشغيل غير متطابقة');
 next.audit.push({id,action:a.action,actor,time:new Date().toISOString()});return next;
}
