/**
 * WhatsApp strictly requires Ogg Opus containers (OggS with OpusHead)
 * for push-to-talk voice notes. Chromium and WebView2 on Windows record
 * into audio/webm (EBML container) with Opus frames.
 *
 * This module converts WebM Opus recordings into standard Ogg Opus
 * bitstreams so WhatsApp treats them as genuine push-to-talk voice notes.
 */

const PUSH_TO_TALK_PREFIX = "audio/ogg";

/** True only when the recorded container can be sent as a voice note. */
export function isPushToTalkContainer(mimeType: string): boolean {
  return mimeType.startsWith(PUSH_TO_TALK_PREFIX);
}

// Standard Ogg CRC-32 lookup table (polynomial 0x04C11DB7)
const OGG_CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++) {
    r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
  }
  OGG_CRC_TABLE[i] = r >>> 0;
}

function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xFF]) >>> 0;
  }
  return crc;
}

/**
 * Creates an Ogg page header and data buffer with valid checksum.
 */
function createOggPage(
  headerType: number,
  granulePos: bigint,
  serial: number,
  seq: number,
  packets: Uint8Array[],
): Uint8Array {
  // Build segment table
  const segmentTable: number[] = [];
  for (const packet of packets) {
    let len = packet.length;
    while (len >= 255) {
      segmentTable.push(255);
      len -= 255;
    }
    segmentTable.push(len);
  }

  const headerLen = 27 + segmentTable.length;
  let payloadLen = 0;
  for (const p of packets) payloadLen += p.length;

  const page = new Uint8Array(headerLen + payloadLen);
  const view = new DataView(page.buffer);

  // 'OggS'
  page[0] = 0x4F; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53;
  page[4] = 0; // version
  page[5] = headerType;
  view.setBigInt64(6, granulePos, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, seq, true);
  view.setUint32(22, 0, true); // CRC zeroed during calculation
  page[26] = segmentTable.length;

  for (let i = 0; i < segmentTable.length; i++) {
    page[27 + i] = segmentTable[i];
  }

  let offset = headerLen;
  for (const p of packets) {
    page.set(p, offset);
    offset += p.length;
  }

  // Calculate CRC
  const checksum = oggCrc(page);
  view.setUint32(22, checksum, true);

  return page;
}

/**
 * Build standard OpusHead packet (RFC 7845).
 */
function createOpusHead(channels = 1, sampleRate = 48000): Uint8Array {
  const head = new Uint8Array(19);
  // 'OpusHead'
  head.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
  head[8] = 1; // version
  head[9] = channels; // channels
  const view = new DataView(head.buffer);
  view.setUint16(10, 384, true); // pre-skip
  view.setUint32(12, sampleRate, true); // original sample rate
  view.setInt16(16, 0, true); // gain
  head[18] = 0; // channel mapping family
  return head;
}

/**
 * Build standard OpusTags packet (RFC 7845).
 */
function createOpusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("whatfast");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  // 'OpusTags'
  tags.set([0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0);
  const view = new DataView(tags.buffer);
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true); // 0 user comments
  return tags;
}

/**
 * Read EBML variable-size integer from buffer at offset.
 */
function readEbmlVarint(buffer: Uint8Array, offset: number): { value: number; size: number } | null {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  if (first === 0) return null;

  let mask = 0x80;
  let size = 1;
  while (!(first & mask) && size <= 8) {
    mask >>= 1;
    size++;
  }
  if (size > 8 || offset + size > buffer.length) return null;

  let value = first & (mask - 1);
  for (let i = 1; i < size; i++) {
    value = (value << 8) | buffer[offset + i];
  }
  return { value, size };
}

/**
 * Extract raw Opus frames from WebM/Matroska container bytes.
 */
export function extractOpusFramesFromWebM(webm: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let pos = 0;

  while (pos < webm.length - 4) {
    // Look for SimpleBlock (ID 0xA3) or Block (ID 0xA1)
    if (webm[pos] === 0xA3 || webm[pos] === 0xA1) {
      pos++; // skip ID
      const sizeVarint = readEbmlVarint(webm, pos);
      if (!sizeVarint) continue;
      pos += sizeVarint.size;

      const blockSize = sizeVarint.value;
      if (pos + blockSize > webm.length) break;

      // Inside SimpleBlock/Block:
      // Track number (EBML varint)
      const trackVarint = readEbmlVarint(webm, pos);
      if (!trackVarint) {
        pos += blockSize;
        continue;
      }
      const headerSkip = trackVarint.size + 2 + 1; // track + timecode (2) + flags (1)
      if (headerSkip < blockSize) {
        const frameData = webm.subarray(pos + headerSkip, pos + blockSize);
        if (frameData.length > 0) {
          frames.push(frameData);
        }
      }
      pos += blockSize;
    } else {
      pos++;
    }
  }

  return frames;
}

/**
 * Remuxes WebM Opus audio into a valid Ogg Opus container.
 * If the input is already Ogg Opus, returns it unmodified.
 */
export function webmOpusToOggOpus(data: Uint8Array): Uint8Array {
  // If already OggS, return directly
  if (data.length >= 4 && data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) {
    return data;
  }

  const frames = extractOpusFramesFromWebM(data);
  if (frames.length === 0) {
    // If no frames extracted, return original data
    return data;
  }

  const serial = 0x524D4557; // 'RMEW'
  const pages: Uint8Array[] = [];

  // Page 0: OpusHead (header type 0x02 = beginning of stream)
  const headPacket = createOpusHead(1, 48000);
  pages.push(createOggPage(0x02, 0n, serial, 0, [headPacket]));

  // Page 1: OpusTags
  const tagsPacket = createOpusTags();
  pages.push(createOggPage(0x00, 0n, serial, 1, [tagsPacket]));

  // Subsequent pages: Opus audio frames (e.g. 1 frame per page or small chunks)
  // Standard 20ms Opus frame has 960 samples at 48 kHz
  const samplesPerFrame = 960n;
  let currentGranule = 0n;
  let seq = 2;

  for (let i = 0; i < frames.length; i++) {
    currentGranule += samplesPerFrame;
    const isLast = i === frames.length - 1;
    const headerType = isLast ? 0x04 : 0x00; // 0x04 = end of stream
    pages.push(createOggPage(headerType, currentGranule, serial, seq++, [frames[i]]));
  }

  // Combine pages
  let totalLength = 0;
  for (const p of pages) totalLength += p.length;
  const ogg = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of pages) {
    ogg.set(p, offset);
    offset += p.length;
  }

  return ogg;
}
