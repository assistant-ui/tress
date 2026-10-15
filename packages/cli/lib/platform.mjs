export const platforms = [
  { os: "darwin", cpu: "arm64", target: "aarch64-apple-darwin" },
  { os: "darwin", cpu: "x64", target: "x86_64-apple-darwin" },
  { os: "linux", cpu: "arm64", target: "aarch64-unknown-linux-musl" },
  { os: "linux", cpu: "x64", target: "x86_64-unknown-linux-musl" },
].map((platform) => ({
  ...platform,
  name: `@assistant-ui/tress-${platform.os}-${platform.cpu}`,
}));

export function currentPlatform(os = process.platform, cpu = process.arch) {
  const platform = platforms.find((entry) => entry.os === os && entry.cpu === cpu);
  if (!platform) {
    throw new Error(`Unsupported platform: ${os}/${cpu}. Tress supports macOS and Linux on ARM64 and x64. On Windows, use WSL with Linux Node.js.`);
  }
  return platform;
}
