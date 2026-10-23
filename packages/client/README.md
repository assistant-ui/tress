# Tress machine-host browser client

Internal source-preview package used by `packages/harness-host` to render the
standalone machine host's browser interface with Tress's existing visual
components. It is private and is not published to npm.

**Existing assistant-ui applications do not need this package.** They keep
their browser components and runtime, agent, tools, and identity. The native
Tress terminal attaches to their authorized Harness thread endpoint. Follow
the [terminal integration guide](../../docs/terminal-integration.md) and the
[existing-app example](../../examples/existing-app/README.md).

## Develop the machine-host browser

From the repository root:

```sh
npm --prefix packages/client ci
npm --prefix packages/client run build
npm --prefix packages/client test
```

The build reuses visual components and scopes styles from `site/src`. Generated
sources and bundles are ignored by Git. React remains an external peer; the
host browser bundle supplies its own instance. The internal headless connector
uses Harness's standalone Tap runtime. The React entry supports prerendering.
The machine host supplies authenticated thread access and optional file APIs;
this package owns neither the thread store nor filesystem execution.

See [machine host setup](../../docs/local-harness.md) to build that separate
standalone workflow. Do not add this package to an existing assistant-ui app
just to enable terminal access.
