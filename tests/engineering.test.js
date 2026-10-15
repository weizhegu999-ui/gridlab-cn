import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateThreePhase,
  calculateShortCircuit,
  calculateRelay,
  RELAY_CURVES,
} from '../src/engineering.js';

function close(actual, expected, relativeTolerance = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) <= relativeTolerance * Math.max(1, Math.abs(expected)),
    `期望 ${expected}，实际 ${actual}`,
  );
}

const powerInput = { lineVoltage: 400, lineCurrent: 100, powerFactor: 0.8 };
const shortInput = { ratedPowerKva: 1000, secondaryVoltageV: 400, impedancePercent: 6 };
const relayInput = { currentA: 200, pickupA: 100, timeMultiplier: 0.1, curve: 'standard' };

test('三相功率：400 V、100 A、PF 0.8 的参考结果，输出采用 VA/W/var', () => {
  const result = calculateThreePhase(powerInput);
  close(result.apparentPower, 69282.0323027551);
  close(result.activePower, 55425.6258422041);
  close(result.reactivePower, 41569.2193816531);
  close(result.phaseAngleDeg, 36.869897645844);
  close(Math.hypot(result.activePower, result.reactivePower), result.apparentPower);
});

test('容性负载无功和相角为负，视在功率与有功不改变', () => {
  const lagging = calculateThreePhase(powerInput);
  const leading = calculateThreePhase({ ...powerInput, reactiveType: 'leading' });
  assert.equal(leading.apparentPower, lagging.apparentPower);
  assert.equal(leading.activePower, lagging.activePower);
  assert.equal(leading.reactivePower, -lagging.reactivePower);
  assert.equal(leading.phaseAngleDeg, -lagging.phaseAngleDeg);
});

test('功率因数端点和零电流：PF 1 无无功，PF 0 为纯无功', () => {
  const unity = calculateThreePhase({ ...powerInput, powerFactor: 1, reactiveType: 'leading' });
  assert.equal(unity.reactivePower, 0);
  assert.equal(unity.phaseAngleDeg, 0);
  assert.equal(unity.activePower, unity.apparentPower);
  const reactive = calculateThreePhase({ ...powerInput, powerFactor: 0 });
  assert.equal(reactive.activePower, 0);
  assert.equal(reactive.reactivePower, reactive.apparentPower);
  assert.equal(reactive.phaseAngleDeg, 90);
  const noLoad = calculateThreePhase({ ...powerInput, lineCurrent: 0, reactiveType: 'leading' });
  assert.equal(noLoad.apparentPower, 0);
  assert.equal(noLoad.activePower, 0);
  assert.equal(noLoad.reactivePower, 0);
});

test('变压器无限大电源：1000 kVA、400 V、uk 6% 的三相短路参考结果', () => {
  const result = calculateShortCircuit(shortInput);
  close(result.ratedCurrentA, 1443.3756729740644);
  close(result.shortCircuitCurrentA, 24056.2612162344);
  close(result.shortCircuitCapacityMva, 16.666666666666668);
  assert.equal(result.totalImpedancePu, 0.06);
  close(Math.sqrt(3) * 400 * result.shortCircuitCurrentA / 1e6, result.shortCircuitCapacityMva);
  assert.deepEqual(result, calculateShortCircuit({ ...shortInput, sourceShortCircuitMva: null }));
});

test('有限上级电源加入标幺阻抗并降低短路电流和短路容量', () => {
  const infinite = calculateShortCircuit(shortInput);
  const finite = calculateShortCircuit({ ...shortInput, sourceShortCircuitMva: 100 });
  close(finite.totalImpedancePu, 0.07);
  close(finite.shortCircuitCurrentA, 20619.65247105806);
  close(finite.shortCircuitCapacityMva, 14.285714285714286);
  assert.equal(finite.ratedCurrentA, infinite.ratedCurrentA);
  assert.ok(finite.shortCircuitCurrentA < infinite.shortCircuitCurrentA);
  assert.ok(finite.shortCircuitCapacityMva < infinite.shortCircuitCapacityMva);
});

test('短路单位换算：电压翻倍则电流减半，短路容量保持相同', () => {
  const original = calculateShortCircuit(shortInput);
  const twiceVoltage = calculateShortCircuit({ ...shortInput, secondaryVoltageV: 800 });
  close(twiceVoltage.ratedCurrentA, original.ratedCurrentA / 2);
  close(twiceVoltage.shortCircuitCurrentA, original.shortCircuitCurrentA / 2);
  close(twiceVoltage.shortCircuitCapacityMva, original.shortCircuitCapacityMva);
});

test('IEC 三种曲线系数不可修改', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(RELAY_CURVES).map(([name, { k, alpha }]) => [name, [k, alpha]])),
    { standard: [0.14, 0.02], very: [13.5, 1], extreme: [80, 2] },
  );
  assert.equal(Object.isFrozen(RELAY_CURVES), true);
  assert.equal(Object.isFrozen(RELAY_CURVES.standard), true);
});

test('IEC 曲线：M=2、TMS=0.1 的三个动作时间参考值', () => {
  close(calculateRelay(relayInput).operatingTimeS, 1.002902702004684);
  close(calculateRelay({ ...relayInput, curve: 'very' }).operatingTimeS, 1.35);
  close(calculateRelay({ ...relayInput, curve: 'extreme' }).operatingTimeS, 2.6666666666666665);
  assert.equal(calculateRelay(relayInput).currentMultiple, 2);
  assert.equal(calculateRelay(relayInput).pickedUp, true);
});

test('M<=1 不启动，动作时间为 null（包括零电流与临界等号）', () => {
  for (const currentA of [0, 50, 100]) {
    const result = calculateRelay({ ...relayInput, currentA });
    assert.equal(result.pickedUp, false);
    assert.equal(result.operatingTimeS, null);
    assert.equal(result.currentMultiple, currentA / relayInput.pickupA);
  }
});

test('M 刚超过 1 时仍返回有限正动作时间，且时间随电流升高而缩短', () => {
  const nearPickup = calculateRelay({ currentA: 1 + Number.EPSILON, pickupA: 1, timeMultiplier: 0.1 });
  assert.equal(nearPickup.pickedUp, true);
  assert.ok(Number.isFinite(nearPickup.operatingTimeS));
  assert.ok(nearPickup.operatingTimeS > 1e12);
  for (const curve of Object.keys(RELAY_CURVES)) {
    const slower = calculateRelay({ ...relayInput, curve });
    const faster = calculateRelay({ ...relayInput, currentA: 500, curve });
    const doubleTms = calculateRelay({ ...relayInput, timeMultiplier: 0.2, curve });
    assert.ok(faster.operatingTimeS < slower.operatingTimeS);
    close(doubleTms.operatingTimeS, 2 * slower.operatingTimeS);
  }
});

test('继电器只使用电流倍数，同倍率不同安培数得到同一时间', () => {
  const result = calculateRelay(relayInput);
  const scaled = calculateRelay({ ...relayInput, currentA: 2000, pickupA: 1000 });
  assert.deepEqual(scaled, result);
});

test('所有数值输入拒绝 NaN、无穷、字符串、null、布尔及缺失值', () => {
  for (const [fn, defaults, keys] of [
    [calculateThreePhase, powerInput, ['lineVoltage', 'lineCurrent', 'powerFactor']],
    [calculateShortCircuit, shortInput, ['ratedPowerKva', 'secondaryVoltageV', 'impedancePercent']],
    [calculateRelay, relayInput, ['currentA', 'pickupA', 'timeMultiplier']],
  ]) {
    for (const key of keys) {
      for (const value of [NaN, Infinity, -Infinity, '100', null, true, undefined]) {
        assert.throws(() => fn({ ...defaults, [key]: value }), RangeError, `${key}: ${String(value)}`);
      }
    }
    for (const value of [null, undefined, 0, 'options', []]) {
      assert.throws(() => fn(value), RangeError);
    }
  }
  for (const sourceShortCircuitMva of [NaN, Infinity, -Infinity, '100', true, 0, -1]) {
    assert.throws(() => calculateShortCircuit({ ...shortInput, sourceShortCircuitMva }), RangeError);
  }
});

test('物理量边界：正值字段拒绝零负值，电流拒绝负值，PF 在 [0,1]', () => {
  for (const [fn, defaults, keys] of [
    [calculateThreePhase, powerInput, ['lineVoltage']],
    [calculateShortCircuit, shortInput, ['ratedPowerKva', 'secondaryVoltageV', 'impedancePercent']],
    [calculateRelay, relayInput, ['pickupA', 'timeMultiplier']],
  ]) {
    for (const key of keys) {
      for (const value of [0, -1]) assert.throws(() => fn({ ...defaults, [key]: value }), RangeError);
    }
  }
  assert.throws(() => calculateThreePhase({ ...powerInput, lineCurrent: -1 }), RangeError);
  assert.throws(() => calculateRelay({ ...relayInput, currentA: -1 }), RangeError);
  for (const powerFactor of [-0.1, 1.000001]) {
    assert.throws(() => calculateThreePhase({ ...powerInput, powerFactor }), RangeError);
  }
});

test('拒绝未知类型和曲线（包括 Object 原型属性）', () => {
  for (const reactiveType of ['capacitive', '', null, 0]) {
    assert.throws(() => calculateThreePhase({ ...powerInput, reactiveType }), RangeError);
  }
  for (const curve of ['unknown', 'toString', '__proto__', null, 0, { toString: () => 'standard' }]) {
    assert.throws(() => calculateRelay({ ...relayInput, curve }), RangeError);
  }
});

test('有限输入若导致数值溢出，也明确抛出 RangeError', () => {
  assert.throws(() => calculateThreePhase({ ...powerInput, lineVoltage: 1e308 }), RangeError);
  assert.throws(() => calculateShortCircuit({ ...shortInput, secondaryVoltageV: Number.MIN_VALUE }), RangeError);
  assert.throws(() => calculateRelay({ ...relayInput, currentA: 1e308, pickupA: 1e-308 }), RangeError);
});
