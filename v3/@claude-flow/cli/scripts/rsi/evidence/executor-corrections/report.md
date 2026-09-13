Decision: corrected executor admission defects; isolated p-limit and RSI remain incomplete.

Source: https://github.com/ruvnet/ruflo/commit/4700668961efbddbdf0d0b895923d79aeb2115ce
Dedicated source CI passed: https://github.com/ruvnet/ruflo/actions/runs/34735995092

Removed the caller-controlled probe execution export, added durable reservations before any version/probe spawn, retained interrupted reservations, fixed nested source/output admission, enforced engine-version admission and corrected overstated OS-isolation claims. The policy, resource proposal and original mission ledger are unchanged. All 178 focused tests pass, including 14 executor tests using simulated child responses; all 7 historical epochs replay under their original sources.

Measured validation: 2 parent starts and 54.866 seconds summed wall time. Four identity-check processes are separately counted; validation descendants, outer model use and full dollars remain unknown. The executor tests ran zero real isolation probes. New repair candidate evaluations, mission epochs and native calls: zero. External-provider spend: $0.

The concrete next blocker is runtime layout: read-only ELF inspection found that Node and prlimit require /lib64/ld-linux-x86-64.so.2, absent from the current sandbox layout. Resolve the loader from the allowed runtime closure, verify startup under unchanged limits and measure OS isolation on a compatible authorized runner. Then finish the fixed p-limit end-to-end witness before testing inheritance. Do not repeat the incompatible host unchanged or acquire broader RuVector material.

The proposed 36 evaluations, 216 isolated starts and 1080000 summed process milliseconds still need explicit operator approval before trials. Largest uncertainty: Whether inherited failure-analysis state improves descendant successor productivity on fresh tasks at matched cost.

Acceptance:
```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/executor.test.mjs
```
Expected: 14 passes with simulated process responses, zero actual isolation probe or candidate starts, and closed execution/RSI gates.

This is a reviewed engineering correction, not a descendant improvement measurement. The original seven epochs and 209784 native calls remain at ledger head 5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e.
