/**
 * PID 控制器 - 用于平滑增益调整
 */

import { PID_PARAMS } from './config';
import { clamp } from './lufs-calculator';

export class PIDController {
  integral = 0;
  lastError = 0;
  Kp: number;
  Ki: number;
  Kd: number;
  integralLimit: number;

  constructor() {
    this.Kp = PID_PARAMS.Kp;
    this.Ki = PID_PARAMS.Ki;
    this.Kd = PID_PARAMS.Kd;
    this.integralLimit = PID_PARAMS.integralLimit;
  }

  /**
   * 计算 PID 输出
   * @param error - 当前误差 (目标值 - 当前值)
   * @returns PID 输出（修正量）
   */
  compute(error: number): number {
    // P 项：比例控制，快速响应
    const proportional = this.Kp * error;

    // I 项：积分控制，消除稳态误差（带抗饱和）
    this.integral += error;
    this.integral = clamp(this.integral, -this.integralLimit, this.integralLimit);
    const integral = this.Ki * this.integral;

    // D 项：微分控制，阻尼震荡
    const derivative = this.Kd * (error - this.lastError);
    this.lastError = error;

    return proportional + integral + derivative;
  }

  /**
   * 重置 PID 状态
   */
  reset(): void {
    this.integral = 0;
    this.lastError = 0;
  }
}
