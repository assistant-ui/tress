# Managed Harness preview

`harness-sdk-0.3.0.tgz` is the unpublished managed-client preview from
[assistant-ui/harness-sdk](https://github.com/assistant-ui/harness-sdk),
commit `c07dab9b1eb32a3800d2bad25e807efa0cfeedef`, package
`packages/harness-sdk/core`. It includes the upstream source and built modules.
The MIT license is alongside the archive.

Packed from the local sibling checkout with:

```sh
npm pack ../../harness-sdk/packages/harness-sdk/core --pack-destination vendor
```

The site depends on this archive so a clean checkout does not need the sibling
repository. Replace it with the published SDK when its managed transport is released.

## Existing-app adapter previews

These additional archives use clean source from the same pinned commit:

| Archive | Upstream directory |
| --- | --- |
| `harness-sdk-ai-sdk-0.0.1.tgz` | `packages/harness-sdk/ai-sdk` |
| `assistant-ui-react-harness-sdk-0.0.1.tgz` | `packages/harness-sdk/assistant-ui` |
| `statewire-node-0.0.1.tgz` | `packages/statewire/node` |

The packages are unpublished source previews. Each archive includes original
source, the MIT license, and bundled ESM output. A `tressPreviewSource` field
records its repository, directory, and revision. Workspace peer ranges are
resolved to the pinned Harness core and Statewire versions. Runtime dependencies
remain external. Rebuild from any checkout containing that upstream commit:

```sh
# From site/, after npm ci:
node scripts/pack-harness-preview.mjs /path/to/harness-sdk
```

The script uses `git archive` of the fixed revision and never packages local
uncommitted changes. Consumers run `npm ci` in `examples/existing-app` using
these committed archives; they do not run the packaging script.
