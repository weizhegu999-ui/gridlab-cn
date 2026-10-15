/**
 * 电气学习计算核心。输入均为有效值，输出不作显示层四舍五入。
 * 三相功率：平衡、正弦稳态，功率因数采用位移功率因数。
 * https://www.electrical-installation.org/enwiki/Definition_of_reactive_power
 * 短路：变压器低压端三相金属性短路，阻抗同角度，幅值相加。
 * https://www.electrical-installation.org/enwiki/3-phase_short-circuit_current_(Isc)_at_any_point_within_a_LV_installation
 * IEC 反时限：理想静态曲线，不含实际装置容差和断路器时间。
 * https://library.e.abb.com/public/ed7bf29f8ef78948c12570eb0045155e/REJ527tech750616ENc.pdf
 */

const SQRT_3 = Math.sqrt(3);

/** k、alpha 对应 t = TMS × k / (M^alpha − 1)，时间单位为 s。 */
export const RELAY_CURVES = Object.freeze({
  standard: Object.freeze({ label: '标准反时限', k: 0.14, alpha: 0.02 }),
  very: Object.freeze({ label: '非常反时限', k: 13.5, alpha: 1 }),
  extreme: Object.freeze({ label: '极端反时限', k: 80, alpha: 2 }),
});

function requireOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new RangeError('请提供包含计算参数的对象。');
  }
}

function requireNumber(value, label, { min = 0, inclusive = false, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${label}必须是有限数值。`);
  }
  if ((inclusive ? value < min : value <= min) || value > max) {
    const lower = inclusive ? '不小于' : '大于';
    const upper = Number.isFinite(max) ? `且不大于 ${max}` : '';
    throw new RangeError(`${label}必须${lower} ${min}${upper}。`);
  }
  return value;
}

function requireFiniteResults(result) {
  for (const value of Object.values(result)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new RangeError('参数导致计算结果超出有限数值范围，请检查数量级。');
    }
  }
  return result;
}

// 避免容性零无功或零相角在显示层出现 “−0”。
function signedMagnitude(magnitude, sign) {
  return magnitude === 0 ? 0 : magnitude * sign;
}

/**
 * @param {{lineVoltage: number, lineCurrent: number, powerFactor: number,
 * reactiveType?: 'lagging'|'leading'}} options
 * @returns {{apparentPower: number, activePower: number, reactivePower: number,
 * phaseAngleDeg: number}} S / VA，P / W，Q / var，φ / °。
 * 被动负载约定：感性（滞后）Q、φ 为正；容性（超前）为负。
 */
export function calculateThreePhase(options) {
  requireOptions(options);
  const { lineVoltage, lineCurrent, powerFactor, reactiveType = 'lagging' } = options;
  requireNumber(lineVoltage, '线电压 / V');
  requireNumber(lineCurrent, '线电流 / A', { inclusive: true });
  requireNumber(powerFactor, '功率因数', { inclusive: true, max: 1 });
  if (reactiveType !== 'lagging' && reactiveType !== 'leading') {
    throw new RangeError('无功类型必须为 lagging（感性）或 leading（容性）。');
  }

  const sign = reactiveType === 'leading' ? -1 : 1;
  const apparentPower = lineVoltage * lineCurrent * SQRT_3;
  const angle = Math.acos(powerFactor);
  // (1 − PF)(1 + PF) 较 1 − PF² 在 PF 接近 1 时更稳定。
  const reactiveMagnitude = apparentPower * Math.sqrt((1 - powerFactor) * (1 + powerFactor));
  return requireFiniteResults({
    apparentPower,
    activePower: apparentPower * powerFactor,
    reactivePower: signedMagnitude(reactiveMagnitude, sign),
    phaseAngleDeg: signedMagnitude(angle * 180 / Math.PI, sign),
  });
}

/**
 * @param {{ratedPowerKva: number, secondaryVoltageV: number,
 * impedancePercent: number, sourceShortCircuitMva?: number|null}} options
 * @returns {{ratedCurrentA: number, shortCircuitCurrentA: number,
 * shortCircuitCapacityMva: number, totalImpedancePu: number}}
 * sourceShortCircuitMva 为空时为无限大电源；标幺基准为变压器额定三相容量。
 * zΣ = uk% / 100 + Sn(MVA) / Ssc(MVA)，Isc = In / zΣ。
 * 同角度幅值相加是简化条件；不含线路、故障电弧、并联电动机和暂态。
 */
export function calculateShortCircuit(options) {
  requireOptions(options);
  const { ratedPowerKva, secondaryVoltageV, impedancePercent, sourceShortCircuitMva = null } = options;
  requireNumber(ratedPowerKva, '额定三相容量 / kVA');
  requireNumber(secondaryVoltageV, '低压侧线电压 / V');
  requireNumber(impedancePercent, '短路阻抗 / %');
  if (sourceShortCircuitMva !== null) {
    requireNumber(sourceShortCircuitMva, '上级电源短路容量 / MVA');
  }

  const ratedPowerMva = ratedPowerKva / 1000;
  const sourceImpedancePu = sourceShortCircuitMva === null ? 0 : ratedPowerMva / sourceShortCircuitMva;
  const totalImpedancePu = impedancePercent / 100 + sourceImpedancePu;
  if (totalImpedancePu <= 0) {
    throw new RangeError('总阻抗过小，超出可计算的数值范围。');
  }
  const ratedCurrentA = (ratedPowerKva / secondaryVoltageV) * (1000 / SQRT_3);
  return requireFiniteResults({
    ratedCurrentA,
    shortCircuitCurrentA: ratedCurrentA / totalImpedancePu,
    shortCircuitCapacityMva: ratedPowerMva / totalImpedancePu,
    totalImpedancePu,
  });
}

/**
 * @param {{currentA: number, pickupA: number, timeMultiplier: number,
 * curve?: 'standard'|'very'|'extreme'}} options
 * @returns {{curve: string, currentMultiple: number, pickedUp: boolean,
 * operatingTimeS: number|null}} M ≤ 1 不启动，动作时间为 null。
 * 实际继电器可能另有启动容差、动作时间下限、复归过程和适用倍数范围。
 */
export function calculateRelay(options) {
  requireOptions(options);
  const { currentA, pickupA, timeMultiplier, curve = 'standard' } = options;
  requireNumber(currentA, '测量电流 / A', { inclusive: true });
  requireNumber(pickupA, '启动整定电流 / A');
  requireNumber(timeMultiplier, '时间倍率 TMS');
  if (typeof curve !== 'string' || !Object.hasOwn(RELAY_CURVES, curve)) {
    throw new RangeError('反时限曲线必须为 standard、very 或 extreme。');
  }

  const currentMultiple = currentA / pickupA;
  if (!Number.isFinite(currentMultiple)) {
    throw new RangeError('电流倍数超出有限数值范围。');
  }
  if (currentMultiple <= 1) {
    return { curve, currentMultiple, pickedUp: false, operatingTimeS: null };
  }
  const { k, alpha } = RELAY_CURVES[curve];
  // expm1 可避免 M 刚超过 1 时，M^alpha − 1 的相减损失精度。
  const denominator = Math.expm1(alpha * Math.log(currentMultiple));
  const operatingTimeS = timeMultiplier * (k / denominator);
  if (!Number.isFinite(operatingTimeS) || operatingTimeS <= 0) {
    throw new RangeError('动作时间超出可计算的数值范围，请检查数量级。');
  }
  return { curve, currentMultiple, pickedUp: true, operatingTimeS };
}
