# MCP tool contract versioning

The public MCP tool contract consists of each exposed tool name, its input JSON Schema, and the canonical tool error envelope and stable error codes documented in [`SPEC.md`](../SPEC.md#error-contract). [`../tool-contract.json`](../tool-contract.json) is the normalized, generated history of published name and input-schema compatibility baselines. The error contract is a separate compatibility-sensitive dimension governed by this policy; its normative definition is in SPEC. The Tool catalogue in [`../SPEC.md`](../SPEC.md#tool-catalogue) governs both the allowed tool names and each tool's allowed top-level input properties.

## Compatibility policy

Additive changes may ship within the current major version when they remain inside the SPEC catalogue. Compatible additions are:

- implementing a new tool already listed in the catalogue;
- adding an optional input property already listed for that tool in the catalogue; or
- loosening an input constraint.

An out-of-catalogue tool or input property is a governance violation, not a compatible addition. Contract checks reject it even when it is otherwise additive. Update the code allowlist only in the same reviewed change as the SPEC catalogue.

Removing or renaming a tool, removing an accepted property, making an optional property required, changing a property's type or format, or tightening an input constraint is a breaking change. The six stable error codes and their meanings are also compatibility-sensitive: removing or renaming a code, changing its meaning, or changing the canonical envelope incompatibly is a breaking change. Additive safe fields within `details` remain compatible.

Intentional breaking changes require all of the following:

1. **Major version bump:** increment the package/server major version.
2. **Migration guide:** publish an entry that identifies affected tools, old and new inputs, and the client action required.
3. **Sunset runway:** announce the deprecation and removal timeline before removing or renaming the old surface, with enough runway for clients to migrate.
4. **Explicit baseline update:** after changing the package major, regenerate and commit `tool-contract.json`; the contract diff and migration material require reviewer sign-off.

Do not suppress the compatibility test or delete prior baselines to land a breaking change. The generator retains every baseline in a package major and refuses a candidate that breaks any of them. A package major bump starts a new active baseline history while preserving older-major entries for audit. The major-version, migration, sunset, and baseline changes must be reviewed together.

## Regenerating the baseline

`tool-contract.json` is generated through a real in-memory MCP client/server connection. Generation injects a fetch implementation and does not require `FUSION_TOKEN`, contact Fusion, or open a socket.

From the repository root, run:

```bash
pnpm contract:generate
pnpm contract:check
```

The generator compares the live contract with every committed baseline for the current package major before writing. Compatible changes append a normalized baseline instead of overwriting the published history. Breaking changes fail generation; follow all four policy steps above, including changing the package major, before regenerating. Governance violations always fail, even after a major bump.

Review the complete `tool-contract.json` diff. Confirm that every added tool and input property appears in the SPEC catalogue and that schema changes match the intended compatibility class. Separately review tool-error changes against SPEC's normative envelope and code meanings; the generated manifest remains input-schema scoped. Commit the generated file with the implementation.

**Never hand-edit `tool-contract.json` or remove its baseline history.** Regenerate it so normalization, ordering, and the SDK-derived JSON Schema stay reproducible. Running `pnpm contract:generate` twice must leave the second run with no diff.
