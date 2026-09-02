// Migration + posSync: en POS-bon må aldrig se ud som et manglende lagertræk.
//
// OPDATERET 2. sep. 2026. Migration 164 løste det som en DATA-rettelse: den satte
// flaget på bons med payment_type = 'pos'. Filteret var for smalt. Ungdommens
// folkemøde havde de samme bons med payment_type = 'cash' (#B4167, #B4152), og
// alarmen kom igen ni dage senere med nye numre.
//
// Vagthunden GENBEREGNER nu §5-reglen (bonOwnsStockCostSql) i stedet for at aflæse
// flaget, så en let-event salgsbon er tavs uanset betalingstype — også før
// migrationen. Migrationen er stadig værd at have: den skriver begrundelsen
// ('event_prep_owns_stock') på selve bonen, så et menneske kan se hvorfor den ikke
// trak. Den er bare ikke længere DET der holder alarmen tavs.
'use strict';
const path=require('path'), os=require('os'), fs=require('fs');
const TEST_DB=path.join(os.tmpdir(),`bon-pos-${Date.now()}.db`);
process.env.DB_PATH=TEST_DB;
const {runMigrations}=require(__dirname+'/../db/migrate');
runMigrations(TEST_DB, path.join(__dirname,'..','db','migrations'));
const {getDb}=require(__dirname+'/../db/database');
const db=getDb();
const {findUndeducted}=require(__dirname+'/../scripts/check-inventory-deduct.js');
const {todayISO,offsetISO}=require(__dirname+'/../db/helpers');
let pass=0,fail=0;
const ok=(c,m)=>{c?(console.log('  \x1b[32m✓\x1b[0m',m),pass++):(console.log('  \x1b[31m✗\x1b[0m',m),fail++);};
const sid=(c)=>db.prepare('SELECT id FROM status_definitions WHERE code=?').get(c).id;
const loc=db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
const ev=db.prepare(`INSERT INTO events (name,start_date,end_date,location_id) VALUES ('T_POS',?,?,?)`)
  .run(offsetISO(-2),offsetISO(-1),loc).lastInsertRowid;
let n=0;
function bon({role,pay,ded=0,st=null}){
  const num=`T_POS_${++n}`;
  const id=db.prepare(`INSERT INTO bons (bon_number,status_id,location_id,event_id,event_role,
      order_date,delivery_date,payment_type,inventory_deducted,inventory_deduct_status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(num,sid('BETALT'),loc,ev,role,offsetISO(-1),offsetISO(-1),pay,ded,st).lastInsertRowid;
  db.prepare(`INSERT INTO bon_lines (bon_id,product_name,quantity,grocy_recipe_id) VALUES (?,'x',1,42)`).run(id);
  return {id,num};
}
console.log('\nPOS-bons må ikke ligne et manglende lagertræk\n');
// Simulér en POS-bon fra FØR rettelsen (flag 0), kør migrationen igen.
const gammel=bon({role:'sales',pay:'pos'});
const almindelig=bon({role:'sales',pay:'invoice'});
const fundFoer=findUndeducted(db,7).map(r=>r.bon_number);
ok(!fundFoer.includes(gammel.num),'reglen tier allerede FØR migrationen — flaget er ikke det der bærer sandheden');

const sql=fs.readFileSync(path.join(__dirname,'..','db/migrations/164_pos_bons_own_no_stock.sql'),'utf8');
db.exec(sql);
const fundEfter=findUndeducted(db,7).map(r=>r.bon_number);
ok(!fundEfter.includes(gammel.num),'efter migrationen er den ude af alarmen');
const r=db.prepare('SELECT inventory_deducted d, inventory_deduct_status s FROM bons WHERE id=?').get(gammel.id);
ok(r.d===1 && r.s==='event_prep_owns_stock','og bonen bærer selv sin begrundelse');
// Den oprindelige afgrænsning var betalingstypen. Den holdt ikke: `cash` er lige
// så meget dagssalg som `pos`, og begge dækkes af prep-bonnens træk. Grænsen går
// ved event-MODELLEN — det er den §5 faktisk trækker.
ok(!fundEfter.includes(almindelig.num),
   'en let-event salgsbon er tavs uanset betalingstype — prep-bonnen ejer trækket (#B4167 betalte kontant)');

// … men vi rydder stadig ikke bredt op: et FESTIVAL-event trækker fra sin egen
// lokation, så dér ejer salgsbonnen sit træk og skal stadig frem hvis det mangler.
const festEv=db.prepare(`INSERT INTO events (name,start_date,end_date,location_id,model)
    VALUES ('T_POS_FEST',?,?,?,'festival')`).run(offsetISO(-2),offsetISO(-1),loc).lastInsertRowid;
const festNum=`T_POS_F`;
const festId=db.prepare(`INSERT INTO bons (bon_number,status_id,location_id,event_id,event_role,
    order_date,delivery_date,payment_type,inventory_deducted)
    VALUES (?,?,?,?,'sales',?,?,'cash',0)`)
  .run(festNum,sid('BETALT'),loc,festEv,offsetISO(-1),offsetISO(-1)).lastInsertRowid;
db.prepare(`INSERT INTO bon_lines (bon_id,product_name,quantity,grocy_recipe_id) VALUES (?,'x',1,42)`).run(festId);
ok(findUndeducted(db,7).map(r=>r.bon_number).includes(festNum),
   'en FESTIVAL-event salgsbon uden træk meldes STADIG — den ejer sit eget træk');
// Idempotens
db.exec(sql);
ok(db.prepare('SELECT COUNT(*) n FROM bons WHERE inventory_deduct_status=?').get('event_prep_owns_stock').n===1,
   'anden kørsel ændrer intet');
try{fs.unlinkSync(TEST_DB);}catch{}
console.log(`\n${pass} PASS · ${fail} FAIL\n`);
process.exit(fail?1:0);
