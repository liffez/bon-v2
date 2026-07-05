#!/usr/bin/env node
/**
 * Test-suite for utils/mail-parser.js
 * Kør: node scripts/test-mail-parser.js
 */

// Load database (needed for getPrefixes)
require('dotenv').config();

const { parseSubject, parseForwardedSender, isBonV1, getPrefixes, buildTag } = require('../utils/mail-parser');

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
    const actualStr = JSON.stringify(actual);
    const expectedStr = JSON.stringify(expected);
    if (actualStr === expectedStr) {
        passed++;
        console.log(`  ✅ ${label}`);
    } else {
        failed++;
        console.log(`  ❌ ${label}`);
        console.log(`     Forventet: ${expectedStr}`);
        console.log(`     Fik:       ${actualStr}`);
    }
}

// ── Test prefixes from DB ───────────────────────────────────
console.log('\n=== getPrefixes() ===');
const prefixes = getPrefixes();
assert('bon prefix', prefixes.bon, 'b-');
assert('offer prefix', prefixes.offer, 't-');
assert('customer prefix', prefixes.customer, 'k-');

// ── Test parseSubject ───────────────────────────────────────
console.log('\n=== parseSubject() ===');

const p = prefixes; // use DB prefixes

let r = parseSubject('#b-3001 Frokost fredag', p);
assert('Bon match', r.routing, 'bon');
assert('Bon number', r.bonNumber, 3001);
assert('Not V1', r.isV1, false);

r = parseSubject('#t-3001 Re: Tilbud', p);
assert('Offer match', r.routing, 'offer');
assert('Offer number', r.offerNumber, 3001);

r = parseSubject('#k-600 Opfølgning', p);
assert('Customer match', r.routing, 'customer');
assert('Customer number', r.customerNumber, 600);

r = parseSubject('#b-3001 #k-600 mail', p);
assert('Both tags', r.routing, 'bon+customer');
assert('Both bon number', r.bonNumber, 3001);
assert('Both customer number', r.customerNumber, 600);

r = parseSubject('Forespørgsel om mad', p);
assert('No tag → unmatched', r.routing, 'unmatched');

r = parseSubject('#Bon:cafe-3380', p);
assert('Bon v1 inbound → ignore', r.routing, 'ignore');
assert('Bon v1 isV1 flag', r.isV1, true);

r = parseSubject('sendt:#Bon:cafe-3380', p);
assert('Bon v1 sent → ignore', r.routing, 'ignore');

r = parseSubject('#B-3001 hej', p);
assert('Case insensitive', r.routing, 'bon');
assert('Case insensitive number', r.bonNumber, 3001);

r = parseSubject('', p);
assert('Empty subject', r.routing, 'unmatched');

r = parseSubject(null, p);
assert('Null subject', r.routing, 'unmatched');

// Custom prefixes (fuldt 5-nøgle-objekt — matcher getPrefixes()-formen)
r = parseSubject('#o-500 test', { bon: 'o-', offer: 'x-', customer: 'c-', purchase_order: 'p-', supplier: 'q-' });
assert('Custom prefix bon', r.routing, 'bon');
assert('Custom prefix bon number', r.bonNumber, 500);

// Regression (F2): et partielt prefix-objekt må ikke crashe — manglende led
// (purchase_order/supplier) skal falde tilbage til defaults, ikke kaste TypeError.
r = parseSubject('#o-500 test', { bon: 'o-' });
assert('Partial prefix: no crash, bon match', r.routing, 'bon');
assert('Partial prefix: default supplier fallback', parseSubject('#s-9 hej', { bon: 'o-' }).routing, 'supplier');

// ── Test buildTag ───────────────────────────────────────────
console.log('\n=== buildTag() ===');

assert('Bon tag', buildTag({ type: 'bon', number: 3001 }, p), '#b-3001');
assert('Offer tag', buildTag({ type: 'offer', number: 150 }, p), '#t-150');
assert('Customer tag', buildTag({ type: 'customer', number: 42 }, p), '#k-42');
assert('Null context', buildTag(null, p), '');
assert('Missing number', buildTag({ type: 'bon' }, p), '');

// ── Test isBonV1 ────────────────────────────────────────────
console.log('\n=== isBonV1() ===');

assert('V1 pattern', isBonV1('#Bon:cafe-3380'), true);
assert('V1 sent', isBonV1('sendt:#Bon:cafe-3380'), true);
assert('V2 pattern', isBonV1('#b-3001'), false);
assert('Normal subject', isBonV1('Hej med dig'), false);
assert('Empty', isBonV1(''), false);
assert('Null', isBonV1(null), false);

// ── Test parseForwardedSender ───────────────────────────────
console.log('\n=== parseForwardedSender() ===');

let fw = parseForwardedSender(`
Hej, kan du se denne?

-------- Forwarded Message --------
From: Peter Hansen <peter@finansforbundet.dk>
Subject: Frokost til 25
Date: Mon, 24 Mar 2025

Vi vil gerne bestille...
`);
assert('Forward: named email', fw.email, 'peter@finansforbundet.dk');
assert('Forward: name', fw.name, 'Peter Hansen');
assert('Forward: firstName', fw.firstName, 'Peter');
assert('Forward: lastName', fw.lastName, 'Hansen');
assert('Forward: company', fw.company, 'Finansforbundet');
assert('Forward: source', fw.source, 'forward_parsed');

fw = parseForwardedSender(`
---------- Videresendt besked ----------
Fra: ny@nytfirma.dk
Emne: Forespørgsel
`);
assert('Forward: bare email', fw.email, 'ny@nytfirma.dk');
assert('Forward: no name', fw.name, null);
assert('Forward: company from domain', fw.company, 'Nytfirma');

fw = parseForwardedSender(`
-------- Forwarded Message --------
From: john@gmail.com
`);
assert('Forward: free domain no company', fw.company, null);

fw = parseForwardedSender('Normal email body without forward block');
assert('No forward block → null', fw, null);

fw = parseForwardedSender(null);
assert('Null body → null', fw, null);

fw = parseForwardedSender('');
assert('Empty body → null', fw, null);

// ── Summary ─────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(50));
process.exit(failed > 0 ? 1 : 0);
