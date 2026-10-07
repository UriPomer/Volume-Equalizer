import { createAudioProcessor, loadAudioWorklets } from './audio-context';
import { LoudnessMeter } from './loudness-meter';
import { MeterState } from './types';

type OutputState = Pick<MeterState, 'outputIntegratedLufs' | 'momentaryLufs' | 'maximumMomentaryLufs'
  | 'maximumShortTermLufs' | 'safetyGain' | 'loudnessGain'>;
export type AudioOutputClient = {
  setGain: (gain: number, time: number) => void;
  release: () => void;
};
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
  private readonly clients = new Map<() => void, number>();
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
        for (const fail of this.clients.keys()) fail();
      };
      this.node = node;
      this.updateProgrammeGain();
      if (this.enabled) node.connect(context.destination);
    });
  }

  retain(onFailure: () => void): AudioOutputClient {
    this.clients.set(onFailure, 1);
    this.updateProgrammeGain();
    if (this.clients.size > 1) this.resetMeasurements(true, true);
    const release = () => {
      if (!this.clients.delete(onFailure)) return;
      if (this.clients.size) {
        this.updateProgrammeGain();
        this.resetMeasurements(true, true);
        return;
      }
      this.closed = true;
      if (this.node) {
        this.node.port.onmessage = null;
        this.node.onprocessorerror = null;
        this.node.disconnect();
      }
      outputs.delete(this.context);
    };
    return { release, setGain: (gain, time) => {
      if (!this.clients.has(onFailure)) return;
      this.clients.set(onFailure, gain);
      this.updateProgrammeGain(time);
    } };
  }

  isReady(): boolean { return this.node !== null && !this.failed && !this.closed; }

  private updateProgrammeGain(time = this.context.currentTime): void {
    // Synchronize the scheduled value/time, never AudioParam.value: its getter
    // can still expose the previous render quantum after setValueAtTime.
    const gain = this.clients.size === 1 ? this.clients.values().next().value! : 1;
    const parameter = this.node?.parameters.get('programmeGain');
    parameter?.cancelScheduledValues(time);
    parameter?.setValueAtTime(gain, time);
  }

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

  private resetMeasurements(preserveIntegrated = false, resetProtection = !preserveIntegrated): void {
    this.meter.reset({ preserveIntegrated });
    if (resetProtection) this.safetyGain = this.loudnessGain = 1;
    this.node?.port.postMessage({type:'reset-meter',epoch:++this.epoch,
      loudnessCeilingLufs:this.targetLufs+2,resetProtection});
  }
}
