import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const output = new URL(`../.tress/markdown-test-${process.pid}.mjs`, import.meta.url);
await build({
  entryPoints: [new URL("../src/components/Markdown.tsx", import.meta.url).pathname],
  outfile: output.pathname,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  jsx: "automatic",
});
const { Markdown } = await import(output.href);
after(() => rm(output, { force: true }));
const render = (text) => renderToStaticMarkup(createElement(Markdown, { text }));

test("the tool list renders as an ordered list with emphasized tool names", () => {
  const html = render(
    "1. **read** – Read a UTF-8 file.\n2. **ls** – List a directory.\n3. **write** – Create a file.\n4. **edit** – Replace text.\n5. **bash** – Run a command.",
  );
  assert.match(html, /<ol>/);
  assert.equal((html.match(/<li>/g) ?? []).length, 5);
  for (const tool of ["read", "ls", "write", "edit", "bash"])
    assert(html.includes(`<strong>${tool}</strong>`));
  assert(!html.includes("**"));
});

test("headings, nested lists, inline code, quotes, links and GFM render semantically", () => {
  const html = render("## Tools\n\nUse `notes.md` and *emphasis*.\n\n- Parent\n  - Child\n\n> Quote\n\n[Docs](https://example.com)\n\n- [x] Done\n\n~~Removed~~\n\n| Tool | Status |\n| --- | --- |\n| read | ready |");
  for (const tag of ["h2", "ul", "code", "em", "blockquote", "del", "table", "th", "td"])
    assert.match(html, new RegExp(`<${tag}[ >]`));
  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /class="markdown-table" role="region" aria-label="Table" tabindex="0"/);
});

test("code keeps whitespace and literal Markdown as incomplete streamed fences become complete", () => {
  for (const text of ["```js\n  const value = '**literal**';\n", "```js\n  const value = '**literal**';\n```"])
    assert.match(render(text), /<pre><code class="language-js">  const value = &#x27;\*\*literal\*\*&#x27;;\n<\/code><\/pre>/);
  const reply = "A **bold** reply with `code` and a [link](https://example.com).";
  for (let length = 1; length <= reply.length; length++)
    assert.doesNotThrow(() => render(reply.slice(0, length)));
});

test("model HTML and dangerous links are inert, and images do not load automatically", () => {
  const html = render('<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n![diagram](https://example.com/image.png)');
  assert(!html.includes("<script>"));
  assert(!html.includes('href="javascript:'));
  assert(!html.includes("<img"));
  assert.match(html, /diagram ↗/);
});
