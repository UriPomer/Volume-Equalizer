import { createAudioProcessor, loadAudioWorklets } from './audio-context';
import { LoudnessMeter } from './loudness-meter';
import { MeterState } from './types';

type OutputState = Pick<MeterState, 'outputIntegratedLufs' | 'momentaryLufs' | 'maximumMomentaryLufs'
  | 'maximumShortTermLufs' | 'safetyGain' | 'loudnessGain'>;
const outputs = new WeakMap<BaseAudioContext, SharedAudioOutput>();

export function getAudioOutput(context: BaseAudioContext, targetLufs: number): SharedAudioOutput {
  let output = outputs.get(context);
  if (!output) {
    output = new SharedAudioOutput(context, targetLufs);
    outputs.set(context, output);
  }
  return output;
}

/** One destination guard per context. Media controllers own programme gain;
 * this object owns mixed PCM, protection, measurement epochs and lifetime. */
export class SharedAudioOutput {
  readonly ready: Promise<void>;
  private node: AudioWorkletNode | null = null;
  private readonly meter: LoudnessMeter;
  private readonly clients = new Set<() => void>();
  private epoch = 0;
  private safetyGain = 1;
  private loudnessGain = 1;
  private enabled = true;
  private failed = false;
  private closed = false;

  constructor(private readonly context: BaseAudioContext, private targetLufs: number) {
    this.meter = new LoudnessMeter(context.sampleRate);
    this.ready = loadAudioWorklets(context).then(() => {
      if (this.closed) return;
      const node = createAudioProcessor(context, this.targetLufs);
      node.port.onmessage = event => {
        const data = event.data;
        if (!this.enabled || data?.type !== 'meter' || data.epoch !== this.epoch) return;
        this.meter.processChannels(data.output);
        this.safetyGain = data.safetyGain;
        this.loudnessGain = data.loudnessGain;
      };
      node.onprocessorerror = () => {
        this.failed = true;
        node.disconnect();
        for (const fail of this.clients) fail();
      };
      this.node = node;
      if (this.enabled) node.connect(context.destination);
    });
  }

  retain(onFailure: () => void): () => void {
    this.clients.add(onFailure);
    return () => {
      if (!this.clients.delete(onFailure) || this.clients.size) return;
      this.closed = true;
      if (this.node) {
        this.node.port.onmessage = null;
        this.node.onprocessorerror = null;
        this.node.disconnect();
      }
      outputs.delete(this.context);
    };
  }

  isReady(): boolean { return this.node !== null && !this.failed && !this.closed; }

  connect(source: AudioNode): void {
    if (!this.isReady()) throw new Error('Mixed output protection unavailable');
    source.connect(this.node!);
  }

  updateSettings(targetLufs: number, enabled: boolean): void {
    if (targetLufs !== this.targetLufs) {
      this.targetLufs = targetLufs;
      this.node?.parameters.get('loudnessCeilingLufs')?.setValueAtTime(targetLufs + 2, this.context.currentTime);
      this.resetMeasurements();
    }
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.resetMeasurements();
    if (this.isReady()) {
      if (enabled) this.node!.connect(this.context.destination);
      else this.node!.disconnect();
    }
  }

  resetForMedia(preserveIntegrated: boolean): void {
    // A source/seek must not erase another media's mixed-output history.
    if (this.clients.size === 1) this.resetMeasurements(preserveIntegrated);
  }

  getState(): OutputState {
    return {
      outputIntegratedLufs: this.meter.getIntegratedLoudness(),
      momentaryLufs: this.meter.getMomentaryLoudness(),
      maximumMomentaryLufs: this.meter.getMaximumMomentaryLoudness(),
      maximumShortTermLufs: this.meter.getMaximumShortTermLoudness(),
      safetyGain: this.safetyGain, loudnessGain: this.loudnessGain
    };
  }

  private resetMeasurements(preserveIntegrated = false): void {
    this.meter.reset({ preserveIntegrated });
    this.safetyGain = this.loudnessGain = 1;
    this.node?.port.postMessage({type:'reset-meter',epoch:++this.epoch,loudnessCeilingLufs:this.targetLufs+2});
  }
}
