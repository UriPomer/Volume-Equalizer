const SURROUND_WEIGHT = Math.pow(10, 1.5 / 10);

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number
  ) {}

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
      - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

export class KWeighting {
  private shelf: Biquad;
  private highPass: Biquad;

  constructor(sampleRate: number) {
    this.shelf = coefficients('shelf', 1681.9744509555319, 0.7071752369554193, 3.99984385397, sampleRate);
    this.highPass = coefficients('highPass', 38.13547087613982, 0.5003270373253953, 0, sampleRate);
  }

  process(x: number): number {
    return this.highPass.process(this.shelf.process(x));
  }

  reset(): void {
    this.shelf.reset();
    this.highPass.reset();
  }
}

export function channelWeight(index: number, count: number): number {
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count) return 0;
  if (count <= 3) return 1;
  if (count === 4) return index < 2 ? 1 : SURROUND_WEIGHT;
  if (count === 5) return index < 3 ? 1 : SURROUND_WEIGHT;
  if (index < 3) return 1;
  if (index === 3) return 0;
  return SURROUND_WEIGHT;
}

function coefficients(
  type: 'shelf' | 'highPass',
  frequency: number,
  q: number,
  gain: number,
  sampleRate: number
): Biquad {
  const k = Math.tan(Math.PI * frequency / sampleRate);
  const a0 = 1 + k / q + k * k;
  const a1 = 2 * (k * k - 1) / a0;
  const a2 = (1 - k / q + k * k) / a0;
  if (type === 'highPass') return new Biquad(1 / a0, -2 / a0, 1 / a0, a1, a2);
  const high = Math.pow(10, gain / 20);
  const middle = Math.pow(high, 0.499666774155);
  return new Biquad(
    (high + middle * k / q + k * k) / a0,
    2 * (k * k - high) / a0,
    (high - middle * k / q + k * k) / a0,
    a1,
    a2
  );
}
