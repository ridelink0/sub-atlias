// Paired outcomes of two variants on one stage. The history page pairs any
// two variants with it, and the collector precomputes the champion's pairs with
// the same code, so both reach the same verdict. An entry is one stage of one
// variant: bits holds one character per task in a fixed order hidden behind a
// hash ('1' solved, '0' not solved, '-' not run); complete says its rows were
// valid and the stage finished; broken says its model calls failed.
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };

export function exactPairedP(aOnly, bOnly) {
  const n = aOnly + bOnly;
  if (!n) return null;
  let tail = 0;
  for (let i = 0; i <= Math.min(aOnly, bOnly); i++) tail += binom(n, i);
  return Math.min(1, 2 * tail / 2 ** n);
}

export function comparePair(a, b, stage, A, B) {
  if (!A || !B || typeof A.bits !== 'string' || typeof B.bits !== 'string') return null;
  let both = 0, aOnly = 0, bOnly = 0, neither = 0, sameSet = A.complete === true && B.complete === true && A.bits.length === B.bits.length;
  for (let i = 0; i < Math.max(A.bits.length, B.bits.length); i++) {
    const x = A.bits[i] ?? '-', y = B.bits[i] ?? '-';
    if ((x === '-') !== (y === '-')) sameSet = false;
    if (x === '-' || y === '-') continue;
    if (x === '1' && y === '1') both++; else if (x === '1') aOnly++; else if (y === '1') bOnly++; else neither++;
  }
  const paired = both + aOnly + bOnly + neither, broken = Boolean(A.broken || B.broken);
  return { a, b, stage, paired, both, aOnly, bOnly, neither, difference: paired ? (bOnly - aOnly) / paired : null, p: exactPairedP(aOnly, bOnly), comparable: sameSet && paired > 0 && !broken, reason: !paired ? 'no shared tasks' : !sameSet ? 'the task sets differ' : broken ? 'one side was a broken run (its model calls failed), so no capability conclusion' : null };
}
