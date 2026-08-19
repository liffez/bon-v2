/* Enhedstest af _isVisible. Funktionen bor inde i HelpSystem-IIFE'en, så dens
   KILDETEKST udtrækkes fra filen og evalueres — det er altså den rigtige kode
   der testes, ikke en kopi der kan drive fra hinanden. */
const fs = require('fs');
const src = fs.readFileSync('shared/help-system.js', 'utf8');

const m = src.match(/function _isVisible\(el\) \{[\s\S]*?\n  \}/);
if (!m) { console.error('FEJL: _isVisible ikke fundet — er den omdøbt?'); process.exit(1); }

let vw = 1400;   // innerWidth tæller scrollbaren med
const window = { get innerWidth() { return vw; } };
let cw = 1385;   // clientWidth er smallere end innerWidth når der er scrollbar
const document = { documentElement: { get clientWidth() { return cw; } } };
const _isVisible = eval('(' + m[0] + ')');

function mkEl({ rects = 1, w = 100, h = 20, left = 0 }) {
    return {
        getClientRects: () => ({ length: rects }),
        getBoundingClientRect: () => ({ width: w, height: h, left, right: left + w, top: 0, bottom: h }),
    };
}

let pass = 0, fail = 0;
const t = (navn, faktisk, forventet) => {
    if (faktisk === forventet) { pass++; console.log('  ok   ' + navn); }
    else { fail++; console.log('  FEJL ' + navn + ' — fik ' + faktisk + ', ventede ' + forventet); }
};

t('null',                                  _isVisible(null), false);
t('almindeligt element',                   _isVisible(mkEl({})), true);
t('display:none (ingen rects)',            _isVisible(mkEl({ rects: 0 })), false);
t('nul areal',                             _isVisible(mkEl({ w: 0, h: 0 })), false);
t('fuld bredde men højde 0 (tom strip)',   _isVisible(mkEl({ w: 520, h: 0 })), false);
t('bredde 0 men højde',                    _isVisible(mkEl({ w: 0, h: 20 })), false);
t('lukket drawer translateX(100%)',        _isVisible(mkEl({ left: 1385, w: 520 })), false);
t('drawer på vej ind',                     _isVisible(mkEl({ left: 1000, w: 520 })), true);
t('panel parkeret til venstre',            _isVisible(mkEl({ left: -520, w: 520 })), false);
t('under fold\'en tæller stadig med',      _isVisible(mkEl({ left: 40, w: 300, h: 20 })), true);
t('præcis på højre kant',                  _isVisible(mkEl({ left: 1385, w: 100 })), false);
t('1px inde fra højre',                    _isVisible(mkEl({ left: 1384, w: 100 })), true);
t('1px inde fra venstre',                  _isVisible(mkEl({ left: -99, w: 100 })), true);

t('parkeret panel bag scrollbaren',        _isVisible(mkEl({ left: 1385, w: 520 })), false);

vw = 0; cw = 0;  // browseren rapporterer 0 (fx skjult panel) — så må vi ikke filtrere alt væk
t('ukendt viewport → antag synlig',        _isVisible(mkEl({ left: 5000, w: 100 })), true);

console.log(`\n${pass} ok · ${fail} fejl`);
process.exit(fail ? 1 : 0);
