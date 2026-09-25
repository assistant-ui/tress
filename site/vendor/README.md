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
