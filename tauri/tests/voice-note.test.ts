import { test } from "node:test";
import assert from "node:assert/strict";

import { isPushToTalkContainer, webmOpusToOggOpus } from "../src/lib/voice-note.ts";

test("only Ogg Opus recordings are push-to-talk voice notes", () => {
  assert.equal(isPushToTalkContainer("audio/ogg;codecs=opus"), true);
  assert.equal(isPushToTalkContainer("audio/ogg"), true);
  assert.equal(isPushToTalkContainer("audio/webm;codecs=opus"), false);
  assert.equal(isPushToTalkContainer("audio/webm"), false);
  assert.equal(isPushToTalkContainer("audio/mp4"), false);
  assert.equal(isPushToTalkContainer(""), false);
});

test("webmOpusToOggOpus passes through existing OggS data", () => {
  const oggHeader = new Uint8Array([0x4F, 0x67, 0x67, 0x53, 0x00, 0x02]);
  const result = webmOpusToOggOpus(oggHeader);
  assert.deepEqual(result, oggHeader);
});

test("webmOpusToOggOpus converts WebM SimpleBlocks into valid Ogg Opus container", () => {
  // Construct a minimal synthetic WebM with 1 SimpleBlock (0xA3)
  // EBML ID: 0xA3, size: 0x86 (6 bytes)
  // Track 1: 0x81 (1 byte), timecode: 0x00 0x00 (2 bytes), flags: 0x80 (1 byte), Opus payload: [0xFC, 0x01] (2 bytes)
  const syntheticWebM = new Uint8Array([
    0x1A, 0x45, 0xDF, 0xA3, // EBML header
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, // EBML size
    0xA3, 0x86, // SimpleBlock ID + length (6 bytes)
    0x81, // Track 1
    0x00, 0x00, // timecode 0
    0x80, // flags keyframe
    0xFC, 0x01, // Opus packet data
  ]);

  const converted = webmOpusToOggOpus(syntheticWebM);
  assert.equal(converted.length > syntheticWebM.length, true);

  // Starts with 'OggS'
  assert.equal(converted[0], 0x4F);
  assert.equal(converted[1], 0x67);
  assert.equal(converted[2], 0x67);
  assert.equal(converted[3], 0x53);

  // Contains OpusHead
  const text = new TextDecoder("ascii").decode(converted);
  assert.equal(text.includes("OpusHead"), true);
  assert.equal(text.includes("OpusTags"), true);
});
