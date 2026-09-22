// packages/core tests — the tiny shared harness (no framework). One module instance = one summary,
// so every test file that imports it counts into the same totals.
let passed = 0, failed = 0;
const pending = [];   // async tests settle before the summary (see the await at the bottom)
export function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      // an async test that threw would otherwise count as a vacuous pass — await it
      pending.push(r.then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        (e) => { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); },
      ));
      return;
    }
    passed++; console.log(`  ✓ ${name}`);
  }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || "not equal"} — got ${a}, expected ${b}`);
}
export function ok(cond, msg) { if (!cond) throw new Error(msg || "expected truthy"); }
export function throws(fn, match, msg) {
  try { fn(); } catch (e) {
    if (match && !e.message.includes(match)) throw new Error(`${msg}: wrong error "${e.message}" (wanted "${match}")`);
    return;
  }
  throw new Error(msg || "expected a throw");
}

export const sp = (id, o = {}) => ({ id, title: id, invoke: o.invoke || id, status: o.status || "next", ...o });

export async function summary() {
  await Promise.all(pending);
  return { passed, failed };
}
