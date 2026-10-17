#!/usr/bin/env bash
# Is production up? A public, read-only check that needs NO credentials: safe to run any time, from
# anywhere, by anyone (including a fresh Claude session that has nothing but this repo).
#
#   deploy/vps/smoke-test.sh                       # https://osceniaevents.com
#   SITE=https://example.com deploy/vps/smoke-test.sh
#
# Exit code 0 = everything answered as expected, 1 = something did not.
set -u

SITE="${SITE:-https://osceniaevents.com}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
fails=0

# check <label> <path> <expected http code> [text the body must contain]
check() {
  local label="$1" path="$2" want="$3" needle="${4:-}"
  local code
  code="$(curl -s -o "$TMP" -m 20 -w '%{http_code}' "$SITE$path" || true)"
  if [[ "$code" == "$want" ]] && { [[ -z "$needle" ]] || grep -qF -- "$needle" "$TMP"; }; then
    printf 'PASS  %-34s %s\n' "$label" "$code"
  else
    printf 'FAIL  %-34s got %s, wanted %s%s\n' "$label" "$code" "$want" "${needle:+ containing '$needle'}"
    fails=$((fails + 1))
  fi
}

echo "Checking $SITE"
check "website home"                  "/"                        200 "<div id=\"root\">"
check "website page /about/"          "/about/"                  200
check "website page /services/"       "/services/"               200
check "ERP app"                       "/erp/"                    200 "<div id=\"root\">"
check "ERP deep link falls back"      "/erp/projects"            200
check "API health + database"         "/health"                  200 '"database":"ok"'
check "API refuses anonymous reads"   "/api/v1/journal-entries"  401
check "API refuses anonymous /me"     "/api/v1/auth/me"          401

# /erp (no slash) must redirect to /erp/
loc="$(curl -s -o /dev/null -m 20 -w '%{http_code} %{redirect_url}' "$SITE/erp" || true)"
if [[ "$loc" == 301* && "$loc" == */erp/ ]]; then printf 'PASS  %-34s %s\n' "/erp redirects to /erp/" "$loc"
else printf 'FAIL  %-34s %s\n' "/erp redirects to /erp/" "$loc"; fails=$((fails + 1)); fi

# The ERP bundle must carry the relative API base, not a Windows path rewritten by Git Bash.
asset="$(curl -s -m 20 "$SITE/erp/" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)"
if [[ -n "$asset" ]]; then
  curl -s -m 30 "$SITE/erp/$asset" -o "$TMP"
  if grep -q 'Program Files' "$TMP" || ! grep -qF '`/api/v1`' "$TMP"; then
    printf 'FAIL  %-34s %s\n' "ERP bundle API base" "wrong (rewritten path?)"; fails=$((fails + 1))
  else printf 'PASS  %-34s %s\n' "ERP bundle API base" "/api/v1"; fi
else printf 'FAIL  %-34s %s\n' "ERP bundle API base" "could not find the bundle"; fails=$((fails + 1)); fi

# Certificate expiry (needs openssl; skipped quietly without it).
host="${SITE#https://}"; host="${host%%/*}"
if command -v openssl >/dev/null 2>&1; then
  end="$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  if [[ -n "$end" ]]; then
    days=$(( ( $(date -d "$end" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))
    if (( days > 14 )); then printf 'PASS  %-34s %s days left (%s)\n' "HTTPS certificate" "$days" "$end"
    else printf 'FAIL  %-34s %s days left (%s)\n' "HTTPS certificate" "$days" "$end"; fails=$((fails + 1)); fi
  fi
fi

echo
if (( fails == 0 )); then echo "ALL PRODUCTION CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; fi
exit $(( fails > 0 ))
