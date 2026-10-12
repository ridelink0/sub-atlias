"""Planted public-subharness regressions. Run only at an exclusive edit boundary.

Each source is restored byte-for-byte in finally, including interrupted checks.
The --run switch is deliberately required; without it this only checks anchors.
No inference or paid API is used. Child ownership comes from run_tree, never PID.
"""
import argparse
import hashlib
import json
import pathlib
import sys
import tempfile

from owned_process import run_tree

ROOT = pathlib.Path(__file__).resolve().parents[2]
CMD = ["node", "test/run.mjs", "public subharness:"]
PROVIDER = "lib/provider.mjs"
NATIVE = "lib/subharness.mjs"
AUTHORITY = "lib/authority.mjs"
CASES = [
    ("unsafe public URL accepted", PROVIDER, "if (url.protocol === 'http:' &&", "if (false &&", "credentials, invalid protocol and unsafe URLs"),
    ("explicit null cache becomes zero", PROVIDER, "'cache_read_input_tokens' in raw ? raw.cache_read_input_tokens : 0", "raw.cache_read_input_tokens ?? 0", "explicit null cache counts"),
    ("Anthropic cache read omitted", PROVIDER, "const totalInput = input + cacheRead + cacheWrite;", "const totalInput = input + cacheWrite;", "Anthropic input, cache reads"),
    ("TTL writes counted twice", PROVIDER, "cacheWrite: cacheWrite - cacheWrite5m - cacheWrite1h", "cacheWrite: cacheWrite", "Anthropic input, cache reads"),
    ("Responses cache input counted twice", PROVIDER, "input: input - cacheRead - cacheWrite", "input: input", "Responses cached input and reasoning"),
    ("missing price becomes free", PROVIDER, "const rate = pricing[k] ?? (k.startsWith('cacheWrite') ? pricing.cacheWrite : undefined);", "const rate = pricing[k] ?? (k.startsWith('cacheWrite') ? pricing.cacheWrite : undefined) ?? 0;", "missing active rates"),
    ("unknown call dropped from aggregate", PROVIDER, "known.length === calls.length && count(total)", "count(total)", "unknown calls are retained"),
    ("unsafe aggregate trusted", PROVIDER, "known.length === calls.length && count(total)", "known.length === calls.length", "unsafe integer aggregate"),
    ("stream assumed terminal", NATIVE, "terminal = !streamed", "terminal = true", "stream without a terminal event"),
    ("Anthropic stream error ignored", NATIVE, "if (e.type === 'error') broken = true;", "if (false) broken = true;", "stream error prevents"),
    ("in-progress JSON trusted", NATIVE, ": ['completed', 'incomplete', 'failed'].includes(e.status)", ": true", "nonstreamed in-progress response"),
    ("upstream redirect follows credential", NATIVE, "redirect: 'manual'", "redirect: 'follow'", "provider redirects are not followed"),
    ("local cookie leaks upstream", NATIVE, "'authorization', 'x-api-key', 'cookie', 'host'", "'authorization', 'x-api-key', 'host'", "upstream receives only the environment credential"),
    ("unknown inference route passes", NATIVE, "if (!inference && !auxiliary)", "if (false)", "unauthorized and unsupported inference paths"),
    ("stream decoder corrupts split UTF8", NATIVE, "decoder.decode(chunk, { stream: true })", "Buffer.from(chunk).toString('utf8')", "split UTF-8 stream bytes"),
    ("forwarded stream bytes corrupt UTF8", NATIVE, "res.write(Buffer.from(chunk))", "res.write(Buffer.from(chunk).toString('utf8'))", "split UTF-8 stream bytes"),
    ("provider credential logged", NATIVE, "receipt.requestBytes = body.length;", "receipt.requestBytes = body.length; receipt.providerSecret = secret;", "upstream receives only the environment credential"),
    ("wrong model priced as configured model", NATIVE, "requested === p.model ? cost(receipt.tokens, p.pricing) : null", "cost(receipt.tokens, p.pricing)", "different native model"),
    ("Codex provider overrides left in parent command", NATIVE, "[...args.slice(0, boundary), ...configs.flatMap((c) => ['-c', c]), ...args.slice(boundary)]", "[...configs.flatMap((c) => ['-c', c]), ...args]", "Codex resume and subcommand arguments"),
    ("Claude resume argv dropped", NATIVE, "args: ['--plugin-dir', ROOT, ...args]", "args: ['--plugin-dir', ROOT]", "Claude resumes natively"),
    ("launcher reports false success", NATIVE, "return result;", "return 0;", "launcher returns native exit status"),
    ("long followup silently clipped", AUTHORITY, "text: String(text)", "text: String(text).slice(0, 200)", "compact restores long authority"),
    ("repeated request text globally deduped", AUTHORITY, "r.id === promptId", "(r.id === promptId || r.text === text)", "repeated requests remain separate occurrences"),
    ("skill amendment globally deduped", AUTHORITY, "!(previous?.kind === 'skill' && previous.file === file && previous.text === text)", "!rows.some((r) => r.kind === 'skill' && r.file === file && r.text === text)", "reverted selected skill"),
    ("clear leaves obsolete authority", "lib/brief.mjs", "authority.clear(payload.session_id)", "void 0", "clear retires prior authority"),
    ("resume authority clipped as evidence", "lib/brief.mjs", "lines.push('\\n' + exact)", "lines.push('\\n' + clip(exact, 1000))", "resume restores long authority"),
    ("selected native Skill not retained", "lib/track.mjs", "cfg.flags.authorityLedger && tool === 'Skill'", "false && tool === 'Skill'", "native Skill invocation"),
    ("truncated shell skill promoted", "lib/track.mjs", "String(output).replace(/\\r\\n/g, '\\n').includes(original.replace(/\\r\\n/g, '\\n'))", "true", "mentioned skill or truncated shell excerpt"),
    ("explicit project skill selection omitted", "lib/router.mjs", "authority.selected(payload);", "void 0;", "explicitly selected project skill"),
    ("concurrent hooks overwrite authority", AUTHORITY, "const lock = ledgerPath(sid) + '.lock';", "const lock = ledgerPath(sid) + '.' + process.pid + '.lock';", "six simultaneous hook processes"),
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run_tests():
    with tempfile.TemporaryFile() as out:
        rc, timed = run_tree(CMD, cwd=str(ROOT), timeout=120, stdout=out)
        out.seek(0)
        text = out.read().decode("utf-8", errors="replace")
    return rc, timed, text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Mutate only after root explicitly grants an exclusive source boundary")
    parser.add_argument("--receipt", type=pathlib.Path, help="External receipt file required when running")
    args = parser.parse_args()
    if args.run and not args.receipt:
        parser.error("--receipt must name the review artifact outside the source tree")
    rows = []
    for name, rel, old, _, _ in CASES:
        text = (ROOT / rel).read_text(encoding="utf-8")
        count = text.count(old)
        rows.append({"name": name, "source": rel, "anchorCount": count})
        if not args.run:
            print(f"{'PASS' if count == 1 else 'FAIL'} unique anchor: {name} ({count})", flush=True)
    if not args.run:
        return 0 if all(r["anchorCount"] == 1 for r in rows) else 1
    if not all(r["anchorCount"] == 1 for r in rows):
        print("FAIL mutation preflight: an anchor must occur exactly once", flush=True)
        return 1
    baseline_rc, baseline_timeout, baseline = run_tests()
    if baseline_rc != 0 or baseline_timeout:
        print(baseline, flush=True)
        print("FAIL mutation preflight: baseline must pass before any source is touched", flush=True)
        return 1
    originals = {rel: (ROOT / rel).read_bytes() for _, rel, _, _, _ in CASES}
    results = []
    try:
        for name, rel, old, new, expected in CASES:
            target = ROOT / rel
            before = originals[rel]
            try:
                text = before.decode("utf-8").replace("\r\n", "\n")
                if text.count(old) != 1:
                    raise RuntimeError(f"mutation anchor changed: {name}")
                target.write_bytes(text.replace(old, new, 1).encode("utf-8"))
                rc, timed, output = run_tests()
                failed_checks = [line.strip()[2:] for line in output.splitlines() if line.strip().startswith("x ")]
                caught = rc == 1 and not timed and any(expected in f for f in failed_checks)
                results.append({"name": name, "source": rel, "caught": caught, "exit": rc, "timeout": timed, "expectedFailure": expected, "failedChecks": failed_checks})
                print(f"{'PASS' if caught else 'FAIL'} planted public break: {name}", flush=True)
                if not caught:
                    print(output[-5000:], flush=True)
            finally:
                target.write_bytes(before)
    finally:
        # Even an exception between a mutation and its local finally restores
        # every owned source to the byte-exact snapshot at the edit boundary.
        for rel, before in originals.items():
            (ROOT / rel).write_bytes(before)
    restored_rc, restored_timeout, restored = run_tests()
    restored_hashes = {rel: {"before": digest(before), "after": digest((ROOT / rel).read_bytes())} for rel, before in originals.items()}
    identical = all(h["before"] == h["after"] for h in restored_hashes.values())
    receipt = {"baselineExit": baseline_rc, "baselineTimeout": baseline_timeout, "mutations": results, "restoredFunctionalExit": restored_rc, "restoredFunctionalTimeout": restored_timeout, "byteExactRestore": identical, "sourceHashes": restored_hashes}
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(restored[-2000:], flush=True)
    print(f"Receipt: {args.receipt}", flush=True)
    return 0 if identical and restored_rc == 0 and not restored_timeout and len(results) == len(CASES) and all(r["caught"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
