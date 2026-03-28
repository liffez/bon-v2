#!/bin/bash
# =============================================================
# Bon v2 — Smoke Test
# Kør: bash scripts/smoke-test.sh
# Kræver: server kører på localhost:4321 (npm start / npm run dev)
# =============================================================

BASE="http://localhost:4321/api"
PASS=0; FAIL=0; BON_ID=""; LINE_ID=""

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

pass() { echo -e "${GREEN}✅ $1${NC}"; ((PASS++)); }
fail() { echo -e "${RED}❌ $1${NC}"; ((FAIL++)); }
section() { echo -e "\n${YELLOW}── $1 ──${NC}"; }

# ─── Helper: tjek HTTP status ───────────────────────────────
expect_status() {
  local desc=$1; local expected=$2; local actual=$3
  [ "$actual" = "$expected" ] && pass "$desc ($actual)" || fail "$desc (forventet $expected, fik $actual)"
}

# ─── Helper: tjek at JSON-felt eksisterer ───────────────────
has_field() {
  echo "$1" | grep -q "\"$2\""
}

# ─── 0. Server tilgængelig? ─────────────────────────────────
section "Forbindelse"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 $BASE/statuses 2>/dev/null)
if [ "$HTTP" = "000" ]; then
  echo -e "${RED}🚫 Serveren svarer ikke på $BASE${NC}"
  echo "   Kør 'npm start' eller 'npm run dev' og prøv igen."
  exit 1
fi
pass "Server svarer"

# ─── 1. Stamdata ─────────────────────────────────────────────
section "Stamdata"

SC=$(curl -s -o /dev/null -w "%{http_code}" $BASE/statuses)
expect_status "GET /api/statuses" "200" "$SC"

STATUSES=$(curl -s $BASE/statuses)
has_field "$STATUSES" "NY" && pass "Status NY findes" || fail "Status NY mangler"
has_field "$STATUSES" "LEVERET" && pass "Status LEVERET findes" || fail "Status LEVERET mangler"

SC=$(curl -s -o /dev/null -w "%{http_code}" $BASE/statuses/NY/transitions)
expect_status "GET /api/statuses/NY/transitions" "200" "$SC"

TRANS=$(curl -s $BASE/statuses/NY/transitions)
has_field "$TRANS" "VENTER" && pass "Transition NY→VENTER findes" || fail "Transition NY→VENTER mangler"

SC=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/customers")
expect_status "GET /api/customers" "200" "$SC"

SC=$(curl -s -o /dev/null -w "%{http_code}" $BASE/settings)
expect_status "GET /api/settings" "200" "$SC"

# ─── 2. Bonliste ─────────────────────────────────────────────
section "Bonliste"

SC=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/bons")
expect_status "GET /api/bons" "200" "$SC"

SC=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/bons/today")
expect_status "GET /api/bons/today" "200" "$SC"

SC=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/bons?status=GODKENDT")
expect_status "GET /api/bons?status=GODKENDT" "200" "$SC"

TODAY=$(date +%Y-%m-%d)
SC=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/bons?date=$TODAY")
expect_status "GET /api/bons?date=today" "200" "$SC"

# ─── 3. Opret bon ─────────────────────────────────────────────
section "Opret bon"

# Hent første kunde-id
FIRST_CUSTOMER=$(curl -s "$BASE/customers" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
if [ -z "$FIRST_CUSTOMER" ]; then
  fail "Ingen kunder i databasen — kør 'npm run seed' først"
  FIRST_CUSTOMER=1
else
  pass "Kunde fundet (id=$FIRST_CUSTOMER)"
fi

TOMORROW=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d "+1 day" +%Y-%m-%d)
CREATE_RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/bons" \
  -H "Content-Type: application/json" \
  -d "{\"customer_id\":$FIRST_CUSTOMER,\"delivery_date\":\"$TOMORROW\",\"pax\":12,\"total_units\":12}")

CREATE_HTTP=$(echo "$CREATE_RESP" | tail -1)
CREATE_BODY=$(echo "$CREATE_RESP" | head -1)

expect_status "POST /api/bons" "201" "$CREATE_HTTP"

BON_ID=$(echo "$CREATE_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
[ -n "$BON_ID" ] && pass "Bon oprettet (id=$BON_ID)" || fail "Intet id i response"

# ─── 4. Hent enkelt bon ───────────────────────────────────────
section "Enkelt bon"

if [ -n "$BON_ID" ]; then
  BON_RESP=$(curl -s "$BASE/bons/$BON_ID")
  SC=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/bons/$BON_ID")
  expect_status "GET /api/bons/$BON_ID" "200" "$SC"
  has_field "$BON_RESP" "delivery_date" && pass "Felt delivery_date findes" || fail "Felt delivery_date mangler (hedder det event_date?)"
  has_field "$BON_RESP" "pax"           && pass "Felt pax findes"           || fail "Felt pax mangler"
  has_field "$BON_RESP" "status"        && pass "Felt status findes"        || fail "Felt status mangler"
fi

# ─── 5. Status-skift ──────────────────────────────────────────
section "Status-skift"

if [ -n "$BON_ID" ]; then
  SC=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/bons/$BON_ID/status" \
    -H "Content-Type: application/json" \
    -d '{"status_code":"VENTER","user_id":1}')
  expect_status "PATCH status NY→VENTER" "200" "$SC"

  SC=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/bons/$BON_ID/status" \
    -H "Content-Type: application/json" \
    -d '{"status_code":"GODKENDT","user_id":1}')
  expect_status "PATCH status VENTER→GODKENDT" "200" "$SC"

  # Ugyldig transition (skal fejle)
  SC=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/bons/$BON_ID/status" \
    -H "Content-Type: application/json" \
    -d '{"status_code":"AFSLUTTET","user_id":1}')
  [ "$SC" != "200" ] && pass "Ugyldig transition afvises ($SC)" || fail "Ugyldig transition GODKENDT→AFSLUTTET burde fejle"

  # Force override
  SC=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/bons/$BON_ID/status" \
    -H "Content-Type: application/json" \
    -d '{"status_code":"BETALT","user_id":1,"force":true}')
  expect_status "Force status til BETALT" "200" "$SC"
fi

# ─── 6. Changelog ─────────────────────────────────────────────
section "Changelog"

if [ -n "$BON_ID" ]; then
  CL=$(curl -s "$BASE/bons/$BON_ID/changelog")
  SC=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/bons/$BON_ID/changelog")
  expect_status "GET /api/bons/$BON_ID/changelog" "200" "$SC"
  # Skal have entries fra status-skiftene ovenfor
  ENTRIES=$(echo "$CL" | grep -o '"id"' | wc -l | tr -d ' ')
  [ "$ENTRIES" -gt 0 ] && pass "Changelog har $ENTRIES entries" || fail "Changelog er tom"
fi

# ─── 7. Prep + køkkeninfo ─────────────────────────────────────
section "Prep + køkkeninfo"

if [ -n "$BON_ID" ]; then
  # Sæt bon tilbage til IGANG for at teste prep (force)
  curl -s -X PATCH "$BASE/bons/$BON_ID/status" \
    -H "Content-Type: application/json" \
    -d '{"status_code":"IGANG","user_id":1,"force":true}' > /dev/null

  SC=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/bons/$BON_ID/prep" \
    -H "Content-Type: application/json" \
    -d '{"ingredients_ready":true,"supplies_ready":false}')
  expect_status "PATCH /api/bons/$BON_ID/prep" "200" "$SC"

  SC=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/bons/$BON_ID/kitchen-info" \
    -H "Content-Type: application/json" \
    -d '{"text":"Smoke test note"}')
  expect_status "PATCH /api/bons/$BON_ID/kitchen-info" "200" "$SC"
fi

# ─── 8. Linjer ────────────────────────────────────────────────
section "Bon-linjer"

if [ -n "$BON_ID" ]; then
  LINE_RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/bons/$BON_ID/lines" \
    -H "Content-Type: application/json" \
    -d '{"product_name":"Testsmørrebrød","quantity":6,"unit_price":45}')

  LINE_HTTP=$(echo "$LINE_RESP" | tail -1)
  LINE_BODY=$(echo "$LINE_RESP" | head -1)
  expect_status "POST /api/bons/$BON_ID/lines" "201" "$LINE_HTTP"

  LINE_ID=$(echo "$LINE_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  [ -n "$LINE_ID" ] && pass "Linje oprettet (id=$LINE_ID)" || fail "Intet linje-id i response"

  if [ -n "$LINE_ID" ]; then
    SC=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/bons/$BON_ID/lines/$LINE_ID" \
      -H "Content-Type: application/json" \
      -d '{"quantity":8}')
    expect_status "PUT /api/bons/$BON_ID/lines/$LINE_ID" "200" "$SC"

    SC=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/bons/$BON_ID/lines/$LINE_ID")
    expect_status "DELETE /api/bons/$BON_ID/lines/$LINE_ID" "200" "$SC"
  fi
fi

# ─── 9. Notifikationer ────────────────────────────────────────
section "Notifikationer"

if [ -n "$BON_ID" ]; then
  SC=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/bons/$BON_ID/notifications" \
    -H "Content-Type: application/json" \
    -d '{"type":"note","message":"Smoke test flyver","priority":"normal"}')
  expect_status "POST /api/bons/$BON_ID/notifications" "201" "$SC"

  SC=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/bons/$BON_ID/notifications")
  expect_status "GET /api/bons/$BON_ID/notifications" "200" "$SC"
fi

# ─── 10. Settings PATCH ──────────────────────────────────────
section "Settings"

SC=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/settings/company_name" \
  -H "Content-Type: application/json" \
  -d '{"value":"Ristet Rug"}')
expect_status "PATCH /api/settings/company_name" "200" "$SC"

# ─── Resultat ─────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════"
TOTAL=$((PASS + FAIL))
echo -e "Resultat: ${GREEN}$PASS ok${NC} / ${RED}$FAIL fejl${NC} (af $TOTAL tests)"
echo "══════════════════════════════════"
[ $FAIL -gt 0 ] && exit 1 || exit 0