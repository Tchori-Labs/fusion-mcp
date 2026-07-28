# Vitest stability burn-in

The stability burn-in looks for order- and timing-dependent failures that a
single test run can miss. One invocation runs the mandatory hermetic Vitest
suite in **10 fresh operating-system processes**. Each process uses the default
`vitest.config.ts`, explicitly disables retries with `--retry=0`, and exits the
burn-in immediately when a repetition fails.

This is an additional diagnostic signal, not a replacement for the required
**Build & Test** check.

## Local invocation

Use Node 22, install the locked dependencies, and run the burn-in:

```bash
pnpm install --frozen-lockfile
pnpm test:stability
```

The default is 10 repetitions. For focused diagnosis, set a positive integer
iteration count:

```bash
FUSION_MCP_STABILITY_ITERATIONS=3 pnpm test:stability
```

Zero, negative numbers, fractions, and non-numeric values are rejected before
Vitest starts.

## Reading results

The runner prints a start and result line for each process:

```text
[stability] iteration 3/10 starting
[stability] iteration 3/10 failed (exit 1)
```

Vitest's default reporter keeps test names and failures visible in the same
terminal or CI log. Its JSON reporter writes a machine-readable file for each
attempt to `stability-results/iteration-<n>.json`. The directory is ignored by
git.

The first non-zero Vitest exit stops the burn-in. The final summary names the
failing repetition and its JSON result path; no failed repetition is retried,
and later repetitions do not run.

## Interpreting an intermittent failure

A test that passes in one repetition and fails in another is a **flake**. Treat
it as a defect that requires root-cause work, such as finding order-dependent
shared state, uncontrolled timers, or unawaited promises. Do not hide the
failure with retries, `--retry`, repeated runs until green, or a weaker
assertion. The correct outcome is a deterministic test and implementation.

Every repetition remains socket-free. The mandatory network guard loads from
the default Vitest configuration in every fresh process, and
`*.live.test.ts` files remain excluded. The stability command needs no live
configuration or credentials.

## CI lane

`.github/workflows/stability.yml` runs the burn-in on manual
`workflow_dispatch` and once daily at an off-peak time. The workflow is
intentionally non-required and separate from branch protection. It installs the
frozen dependency graph and uses the default 10 repetitions without an
environment override.

When the job fails, CI uploads the available `stability-results/*.json` files as
the `stability-json-results` artifact for five days. Successful runs do not
upload an artifact. Use the per-iteration log and the failing repetition's JSON
together to identify the test before beginning root-cause analysis.
