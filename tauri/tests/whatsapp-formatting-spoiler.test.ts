import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWhatsAppText,
  type WhatsAppInlineSegment,
  type WhatsAppTextBlock,
} from "../src/lib/whatsapp-formatting.ts";

function segments(block: WhatsAppTextBlock): WhatsAppInlineSegment[] {
  assert.ok("segments" in block);
  return block.segments;
}

test("parses a spoiler delimited by double pipes", () => {
  const [block] = parseWhatsAppText("||hidden||");

  assert.deepEqual(segments(block!), [
    { kind: "text", text: "hidden", styles: ["spoiler"] },
  ]);
});

test("keeps the text around a spoiler unstyled", () => {
  const [block] = parseWhatsAppText("before ||hidden|| after");

  assert.deepEqual(segments(block!), [
    { kind: "text", text: "before ", styles: [] },
    { kind: "text", text: "hidden", styles: ["spoiler"] },
    { kind: "text", text: " after", styles: [] },
  ]);
});

test("parses several spoilers in the same message", () => {
  const [block] = parseWhatsAppText("||one|| and ||two||");

  assert.deepEqual(segments(block!), [
    { kind: "text", text: "one", styles: ["spoiler"] },
    { kind: "text", text: " and ", styles: [] },
    { kind: "text", text: "two", styles: ["spoiler"] },
  ]);
});

test("a spoiler inherits and composes with the other inline styles", () => {
  const [bold] = parseWhatsAppText("*||hidden||*");
  const [spoiler] = parseWhatsAppText("||*hidden*||");

  assert.deepEqual(segments(bold!), [
    { kind: "text", text: "hidden", styles: ["bold", "spoiler"] },
  ]);
  assert.deepEqual(segments(spoiler!), [
    { kind: "text", text: "hidden", styles: ["spoiler", "bold"] },
  ]);
});

test("a spoiler keeps links and mentions atomic", () => {
  const [block] = parseWhatsAppText("||https://example.com/a @Ann||", {
    mentions: ["Ann"],
  });

  assert.deepEqual(segments(block!), [
    {
      kind: "link",
      text: "https://example.com/a",
      href: "https://example.com/a",
      styles: ["spoiler"],
    },
    { kind: "text", text: " ", styles: ["spoiler"] },
    {
      kind: "mention",
      text: "@Ann",
      mention: "Ann",
      styles: ["spoiler"],
    },
  ]);
});

test("keeps malformed spoilers as literal text", () => {
  const [unclosed] = parseWhatsAppText("||hidden");
  const [spaced] = parseWhatsAppText("|| hidden||");
  const [trailingSpace] = parseWhatsAppText("||hidden ||");
  const [inWord] = parseWhatsAppText("mid||dle||");

  assert.deepEqual(segments(unclosed!), [
    { kind: "text", text: "||hidden", styles: [] },
  ]);
  assert.deepEqual(segments(spaced!), [
    { kind: "text", text: "|| hidden||", styles: [] },
  ]);
  assert.deepEqual(segments(trailingSpace!), [
    { kind: "text", text: "||hidden ||", styles: [] },
  ]);
  assert.deepEqual(segments(inWord!), [
    { kind: "text", text: "mid||dle||", styles: [] },
  ]);
});

test("a spoiler does not leak into the next line", () => {
  const blocks = parseWhatsAppText("||hidden||\nplain");

  assert.deepEqual(blocks.map((block) => block.kind), ["paragraph", "paragraph"]);
  assert.deepEqual(segments(blocks[0]!), [
    { kind: "text", text: "hidden", styles: ["spoiler"] },
  ]);
  assert.deepEqual(segments(blocks[1]!), [
    { kind: "text", text: "plain", styles: [] },
  ]);
});
