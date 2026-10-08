import assert from 'node:assert/strict';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { floatWavHeader } from './audio-test-artifacts.mjs';

export class ContinuityRecording {
  constructor(artifacts, contextId) {
    this.path = join(artifacts, 'capture-' + contextId + '.pcm');
    this.fd = openSync(this.path, 'w'); this.packets = 0; this.error = null;
  }
  append(packet) {
    if (this.fd === null) return;
    const pcm = Buffer.from(packet.pcm, 'base64');
    if (!this.packets) { this.firstFrame = packet.startFrame; this.framesPerPacket = pcm.length / 16; }
    if (packet.sequence !== this.packets || packet.startFrame !== this.firstFrame + this.packets * this.framesPerPacket
      || pcm.length !== this.framesPerPacket * 16) { this.error = 'Missing, duplicated or discontinuous PCM packet'; return; }
    writeSync(this.fd, pcm); this.packets++;
  }
  close() { if (this.fd !== null) { closeSync(this.fd); this.fd = null; } }
}

export function saveContinuityPcm(artifacts, recording, rate, report) {
  recording?.close();
  assert.ok(recording?.packets > 30, 'Capture enough continuous audio');
  assert.equal(recording.error, null, 'No missing recording packets');
  const { firstFrame } = recording, step = Math.round(rate / 10), frames = recording.packets * step;
  assert.equal(recording.framesPerPacket, step, 'Native sample clock');
  const dropoutBlocks = [], offset = Math.round(rate * .015) - 1;
  const pauses = []; let currentPause;
  for (const event of report.mediaEvents) {
    if (event.type === 'pause' && !currentPause) currentPause = { start: event.contextTime, end: Infinity };
    if (event.type === 'play' && currentPause) { currentPause.end = event.contextTime; pauses.push(currentPause); currentPause = null; }
  }
  if (currentPause) pauses.push(currentPause);
  const raw = openSync(recording.path, 'r'), input = openSync(join(artifacts, 'original.wav'), 'w');
  const output = openSync(join(artifacts, 'output.wav'), 'w'), trace = openSync(join(artifacts, 'pcm-trace.jsonl'), 'w');
  const header = floatWavHeader(frames * 8, rate, 2), inputHash = createHash('sha256').update(header), outputHash = createHash('sha256').update(header);
  writeSync(input, header); writeSync(output, header);
  const bytes = Buffer.alloc((step + offset) * 16), inputBytes = Buffer.alloc(step * 8), outputBytes = Buffer.alloc(step * 8);
  let audibleBlocks = 0;
  try {
    for (let start = 0; start < frames; start += step) {
      const count = Math.min(step + offset, frames - start);
      assert.equal(readSync(raw, bytes, 0, count * 16, start * 16), count * 16, 'All recorded PCM is present');
      let inputEnergy = 0, outputEnergy = 0;
      for (let frame = 0; frame < step; frame++) for (let channel = 0; channel < 2; channel++) {
        const value = bytes.readFloatLE(frame * 16 + channel * 4);
        const out = bytes.readFloatLE(frame * 16 + 8 + channel * 4);
        assert.ok(Number.isFinite(value) && Number.isFinite(out), 'Native PCM must remain finite');
        inputBytes.writeFloatLE(value, (frame * 2 + channel) * 4); outputBytes.writeFloatLE(out, (frame * 2 + channel) * 4);
        inputEnergy += value ** 2;
        if (count === step + offset) outputEnergy += bytes.readFloatLE((frame + offset) * 16 + 8 + channel * 4) ** 2;
      }
      writeSync(input, inputBytes); writeSync(output, outputBytes); inputHash.update(inputBytes); outputHash.update(outputBytes);
      if (start < rate || count < step + offset) continue;
      const inputRms = Math.sqrt(inputEnergy / (step * 2)), outputRms = Math.sqrt(outputEnergy / (step * 2));
      const contextTime = (firstFrame + start) / rate;
      const playing = !pauses.some(pause => contextTime < pause.end && contextTime + (step + offset) / rate > pause.start);
      const block = { contextTime, inputRms, outputRms, playing, ratio: inputRms > 0 ? outputRms / inputRms : null };
      writeSync(trace, JSON.stringify(block) + '\n');
      if (playing && inputRms > .003) { audibleBlocks++; if (outputRms < inputRms * .05) dropoutBlocks.push(block); }
    }
  } finally { for (const fd of [raw, input, output, trace]) closeSync(fd); }
  report.pcm = { sampleRate: rate, startContextTime: firstFrame / rate, seconds: frames / rate, packets: recording.packets,
    audibleSeconds: audibleBlocks / 10, dropoutBlocks, inputSha256: inputHash.digest('hex'), outputSha256: outputHash.digest('hex') };
  assert.ok(audibleBlocks >= 30, 'Silent input cannot pass');
  if (report.mode === 'bilibili-page') {
    const programmeSeconds = report.playbacks.reduce((seconds, playback) => seconds + playback.duration, 0);
    assert.ok(frames / rate >= programmeSeconds - 2, 'Record the complete native programme');
    assert.ok(audibleBlocks / 10 >= programmeSeconds * .8, 'The reported speech video must have a continuous audible reference');
  }
  assert.equal(dropoutBlocks.length, 0, 'Audible input must not disappear from the actual destination output for a 100-ms block');
}
