// scripts/audit-grocy-prices.js
// ============================================================
// Find indkøbsposteringer med en pris der stikker vildt ud.
//
// Grocys UI kan ikke søge på pris, så en forkert postering er i praksis
// umulig at finde i hånden — man ved kun at den findes, fordi `last_price`
// pludselig er absurd. Scriptet leder i stedet i `stock_log` og skriver
// journal-id'et ud, så rækken kan findes direkte i Lagerjournalen.
//
// Metode: hver postering sammenlignes med medianen af varens ØVRIGE
// indkøbspriser. Medianen af alle ville ikke duge — har en vare kun to køb
// hvoraf det ene er fejlen, trækker fejlen medianen med sig og skjuler sig
// selv. Det skete for Stjerne Anis (4.078.625 kr/kg).
//
// Den mest almindelige fejl er faktor 1000 (kg/g-forveksling) og
// pakkeprisen tastet som styk-pris.
//
// READ-ONLY. Måler mod grocy-hq.
//
//   node --env-file=.env scripts/audit-grocy-prices.js
// ============================================================

const U=process.env.GROCY_HQ_URL,K=process.env.GROCY_HQ_KEY;
const g=async(p,t=3)=>{for(let i=0;i<t;i++){try{const r=await fetch(U+p,{headers:{'GROCY-API-KEY':K}});if(r.ok)return r.json();}catch(e){}await new Promise(s=>setTimeout(s,200*(i+1)));}return null;};
const pool=async(a,n,f)=>{const o=[];let i=0;await Promise.all(Array.from({length:n},async()=>{while(i<a.length){const k=i++;o[k]=await f(a[k]);}}));return o;};
const med=a=>{const s=[...a].sort((x,y)=>x-y);return s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2;};
(async()=>{
 const prods=await g('/objects/products');
 console.log(`Scanner indkøbshistorik for ${prods.length} produkter i PRODUKTION…\n`);
 const fund=[];
 await pool(prods,6,async p=>{
   const log=await g(`/objects/stock_log?query%5B%5D=product_id%3D${p.id}&limit=500`);
   if(!Array.isArray(log)) return;
   const kob=log.filter(l=>l.transaction_type==='purchase'&&String(l.undone)!=='1'&&Number(l.price)>0);
   if(kob.length<2) return;
   // Sammenlign hver postering med medianen af de ØVRIGE. Med kun to indkøb,
   // hvoraf det ene er fejlen, trækker fejlen ellers medianen med sig og
   // skjuler sig selv — præcis hvad der skete for Stjerne Anis.
   kob.forEach((l,idx)=>{
     const pr=Number(l.price);
     const andre=kob.filter((_,j)=>j!==idx).map(x=>Number(x.price));
     if(!andre.length) return;
     const m=med(andre);
     if(!(m>0)) return;
     if(pr>m*8) fund.push({vare:p.name,id:l.id,dato:String(l.purchased_date||l.row_created_timestamp).slice(0,10),
                           maengde:Number(l.amount),pris:pr,normal:m,faktor:pr/m});
   });
 });
 fund.sort((a,b)=>b.faktor-a.faktor);
 if(!fund.length) return console.log('Ingen afvigere fundet.');
 console.log(`${fund.length} indkøbsposteringer stikker mere end 8× ud fra varens normale pris:\n`);
 console.log('  vare                     købsdato     mængde        pris    normalt   faktor  journal-id');
 fund.forEach(f=>console.log(
   `  ${f.vare.padEnd(24).slice(0,24)} ${f.dato}  ${String(Math.round(f.maengde*10000)/10000).padStart(9)} ${f.pris.toFixed(2).padStart(11)} ${f.normal.toFixed(2).padStart(10)} ${(Math.round(f.faktor)+'×').padStart(8)}  ${f.id}`));
})();
