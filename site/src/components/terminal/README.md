# Browser terminal components

Badge, Spinner, KeyboardShortcuts, and ToolCall are small React DOM adaptations
of [TermCN](https://www.termcn.dev/)'s MIT-licensed Ink components by Aniket Pawar.
The original components use Ink/OpenTUI renderers and cannot render directly in
this website. These versions use semantic HTML and the site's CSS tokens; no
Ink, OpenTUI, terminal emulator, or animation dependency is bundled.

Sources:
- https://www.termcn.dev/r/ink/badge.json
- https://www.termcn.dev/r/ink/spinner.json
- https://www.termcn.dev/r/ink/keyboard-shortcuts.json
- https://www.termcn.dev/r/ink/tool-call.json
- https://github.com/shadcn-labs/termcn

Adaptations: native details/summary provides keyboard disclosure; kbd labels
expose existing shortcuts; the braille spinner uses CSS steps and respects
reduced motion. ToolCall only shows metadata actually supplied by tress (tool
requests and whether the overall run is active), without invented tool results,
success states, or elapsed times. The neutral palette matches the site's black
theme. TerminalIcon is a local set of small line icons, not an upstream component.

The upstream MIT license is preserved in LICENSE in this directory.
