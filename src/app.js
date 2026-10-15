import { calculateThreePhase, calculateShortCircuit, calculateRelay, RELAY_CURVES } from './engineering.js';
import { QUESTIONS } from './questions.js';

const $ = (selector) => document.querySelector(selector);
const labels = { relay: '过流保护曲线', power: '三相功率计算', fault: '变压器短路估算', quiz: '知识自测' };
const results = {};
let activeView = 'relay';
let quizIndex = 0;
let toastTimer;
const STORAGE_KEY = 'gridlab.quiz.v1';

function format(value, digits = 2) {
  if (value === null) return '不启动';
  if (value !== 0 && (Math.abs(value) >= 1e7 || Math.abs(value) < 0.001)) return value.toExponential(2);
  return value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function numberField(form, name, optional = false) {
  const input = form.elements.namedItem(name);
  if (input.validity.badInput) throw new RangeError('请填写有效的数字。');
  if (input.value.trim() === '') {
    if (optional) return null;
    throw new RangeError('请填写所有必填参数。');
  }
  return input.valueAsNumber;
}

function parameters(view) {
  const form = $(`#${view}-form`);
  if (view === 'relay') return { currentA: numberField(form, 'currentA'), pickupA: numberField(form, 'pickupA'), timeMultiplier: numberField(form, 'timeMultiplier'), curve: form.elements.curve.value };
  if (view === 'power') return { lineVoltage: numberField(form, 'lineVoltage'), lineCurrent: numberField(form, 'lineCurrent'), powerFactor: numberField(form, 'powerFactor'), reactiveType: form.elements.reactiveType.value };
  return { ratedPowerKva: numberField(form, 'ratedPowerKva'), secondaryVoltageV: numberField(form, 'secondaryVoltageV'), impedancePercent: numberField(form, 'impedancePercent'), sourceShortCircuitMva: numberField(form, 'sourceShortCircuitMva', true) };
}

function metric(label, value, unit, sub, accent = false) {
  return `<div class="metric"><span class="metric-label">${label}</span><strong class="metric-value${accent ? ' accent' : ''}">${value}<span class="metric-unit">${unit}</span></strong><span class="metric-sub">${sub}</span></div>`;
}

function showToast(message) {
  const toast = $('#status-message');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

function switchView(view, updateHash = true) {
  if (!Object.hasOwn(labels, view)) view = 'relay';
  activeView = view;
  document.querySelectorAll('.view').forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll('[data-view]').forEach((button) => {
    const current = button.dataset.view === view;
    button.classList.toggle('active', current);
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#breadcrumb-current').textContent = labels[view];
  if (updateHash) history.replaceState(null, '', `#${view}`);
}

function drawRelayChart(params, result) {
  // Both axes are logarithmic. Keep the entire SI/VI/EI family in view.
  const svg = $('#relay-chart');
  $('#selected-curve-label').textContent = RELAY_CURVES[params.curve].label;
  const x0 = 58, x1 = 690, y0 = 25, y1 = 278;
  const minM = 1.05, maxM = 30;
  const timeAt = (multiple, curve) => {
    const { k, alpha } = RELAY_CURVES[curve];
    return params.timeMultiplier * k / Math.expm1(alpha * Math.log(multiple));
  };
  const allTimes = Object.keys(RELAY_CURVES).flatMap((curve) => [timeAt(minM, curve), timeAt(maxM, curve)]);
  const minTime = Math.max(1e-12, 10 ** Math.floor(Math.log10(Math.min(...allTimes))));
  const maxTime = Math.min(1e14, 10 ** Math.ceil(Math.log10(Math.max(...allTimes))));
  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime) || maxTime <= minTime) {
    svg.innerHTML = '<text x="360" y="150" text-anchor="middle" fill="#87957e" font-size="14">参数超出图表范围，请参考上方数值。</text>';
    return;
  }
  const x = (m) => x0 + Math.log(m / minM) / Math.log(maxM / minM) * (x1 - x0);
  const y = (t) => y1 - Math.log(t / minTime) / Math.log(maxTime / minTime) * (y1 - y0);
  const text = (px, py, content, extra = '') => `<text x="${px}" y="${py}" fill="#9ba58f" font-size="10" font-family="Segoe UI, sans-serif" ${extra}>${content}</text>`;
  let markup = '<defs><clipPath id="plot-clip"><rect x="58" y="25" width="632" height="253"/></clipPath></defs>';
  for (const m of [1.05, 2, 3, 5, 10, 20, 30]) {
    const px = x(m);
    markup += `<path d="M${px},${y0}V${y1}" stroke="#e8ece1" stroke-dasharray="3 4"/>`;
    markup += text(px, y1 + 22, m === 1.05 ? '1.05' : String(m), 'text-anchor="middle"');
  }
  const startExponent = Math.round(Math.log10(minTime));
  const endExponent = Math.round(Math.log10(maxTime));
  const tickStep = Math.max(1, Math.ceil((endExponent - startExponent) / 6));
  for (let exponent = startExponent; exponent <= endExponent; exponent += tickStep) {
    const t = 10 ** exponent;
    const py = y(t);
    markup += `<path d="M${x0},${py}H${x1}" stroke="#e8ece1" stroke-dasharray="3 4"/>`;
    markup += text(x0 - 11, py + 4, t >= 10000 || t < 0.001 ? `10^${exponent}` : String(t), 'text-anchor="end"');
  }
  markup += text(12, 12, 't / s') + text(x1, 317, '电流倍数 M = I / Iₛ', 'text-anchor="end"');
  markup += '<g clip-path="url(#plot-clip)">';
  // Draw the selected curve last, so it remains visible at intersections.
  const order = Object.keys(RELAY_CURVES).filter((key) => key !== params.curve).concat(params.curve);
  for (const curve of order) {
    const points = [];
    for (let i = 0; i <= 180; i++) {
      const m = minM * (maxM / minM) ** (i / 180);
      points.push(`${x(m).toFixed(2)},${y(timeAt(m, curve)).toFixed(2)}`);
    }
    const selected = curve === params.curve;
    const color = selected ? '#df8453' : curve === 'very' ? '#a3b99a' : '#c7cebd';
    markup += `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="${selected ? 2.8 : 1.5}" ${selected ? '' : 'stroke-dasharray="5 5"'}/>`;
  }
  const inRange = result.pickedUp && result.currentMultiple >= minM && result.currentMultiple <= maxM && result.operatingTimeS >= minTime && result.operatingTimeS <= maxTime;
  if (inRange) {
    const px = x(result.currentMultiple), py = y(result.operatingTimeS);
    markup += `<path d="M${px},${y1}V${py}H${x0}" fill="none" stroke="#df8453" opacity=".5" stroke-dasharray="4 4"/><circle cx="${px}" cy="${py}" r="8" fill="#df8453" opacity=".15"/><circle cx="${px}" cy="${py}" r="4" fill="#df8453" stroke="#fff" stroke-width="2"/>`;
  }
  markup += '</g>';
  const annotation = !result.pickedUp ? 'M ≤ 1：未达到启动条件' : !inRange ? '当前点在图表范围外，动作时间见数值栏' : `当前工作点 · ${format(result.operatingTimeS, 3)} s`;
  markup += `<rect x="${x1 - 257}" y="8" width="257" height="22" fill="#fdfefa" opacity=".9"/>`;
  markup += text(x1, 22, annotation, 'text-anchor="end"');
  svg.innerHTML = markup;
}

function drawPowerChart(params, result) {
  const svg = $('#power-chart');
  if (result.apparentPower === 0) {
    svg.innerHTML = '<path d="M90 210H630M90 40V275" stroke="#cdd7c3"/><circle cx="90" cy="210" r="4" fill="#df8453"/><text x="350" y="145" text-anchor="middle" fill="#8b987e" font-size="15">电流为 0，三种功率均为 0。</text>';
    $('#power-caption').textContent = '零电流状态下，电流与电压的相位差不具有物理定义。';
    return;
  }
  const originX = 160, originY = params.reactiveType === 'leading' ? 40 : 280;
  const sign = result.reactivePower < 0 ? 1 : -1;
  const px = originX + 240 * params.powerFactor;
  const py = originY + sign * 240 * Math.sqrt((1 - params.powerFactor) * (1 + params.powerFactor));
  const color = result.reactivePower < 0 ? '#6c9aa6' : '#8baf80';
  svg.innerHTML = `<path d="M80,${originY}H655" stroke="#d2dac9"/><path d="M${originX},35V285" stroke="#d2dac9"/>
    <path d="M${originX},${originY}H${px}V${py}Z" fill="#dfe8d4" opacity=".4"/>
    <path d="M${originX},${originY}H${px}" stroke="#688b66" stroke-width="3"/>
    <path d="M${px},${originY}V${py}" stroke="${color}" stroke-width="3" stroke-dasharray="6 4"/>
    <path d="M${originX},${originY}L${px},${py}" stroke="#df8453" stroke-width="3"/>
    <circle cx="${px}" cy="${py}" r="4" fill="#df8453"/>
    <text x="${(originX + px) / 2}" y="${originY + (sign < 0 ? 28 : -16)}" font-size="14" text-anchor="middle" fill="#5f805c">P = ${format(result.activePower / 1000)} kW</text>
    <text x="${Math.min(px + 18, 565)}" y="${(originY + py) / 2 + 4}" font-size="13" fill="${color}">Q = ${format(result.reactivePower / 1000)} kvar</text>
    <text x="${(originX + px) / 2 - 8}" y="${(originY + py) / 2 + (sign < 0 ? -20 : 30)}" font-size="15" text-anchor="middle" fill="#ca7a4c">S = ${format(result.apparentPower / 1000)} kVA</text>
    <text x="650" y="${originY - 10}" font-size="11" fill="#99a68a">P</text><text x="75" y="35" font-size="11" fill="#99a68a">+Q</text>`;
  $('#power-caption').textContent = `φ = ${format(result.phaseAngleDeg)}° · ${params.reactiveType === 'lagging' ? '感性负载，电流滞后，Q ≥ 0。' : '容性负载，电流超前，Q ≤ 0。'} 两轴采用相同比例，斜边反映功率因数角。`;
}

function update(view) {
  const error = $(`#${view}-error`);
  try {
    const params = parameters(view);
    const result = view === 'relay' ? calculateRelay(params) : view === 'power' ? calculateThreePhase(params) : calculateShortCircuit(params);
    results[view] = { parameters: params, result };
    error.textContent = '';
    if (view === 'relay') {
      $('#relay-results').innerHTML = metric('动作时间 t', format(result.operatingTimeS, 3), result.pickedUp ? 's' : '', result.pickedUp ? '理想继电器动作时间' : '未超过启动电流', true)
        + metric('电流倍数 M', format(result.currentMultiple), '×', '测量电流 / 启动电流')
        + metric('保护状态', result.pickedUp ? '已启动' : '未启动', '', RELAY_CURVES[params.curve].label);
      drawRelayChart(params, result);
    } else if (view === 'power') {
      $('#power-results').innerHTML = metric('有功功率 P', format(result.activePower / 1000), 'kW', '负载吸收的有功', true)
        + metric('无功功率 Q', format(result.reactivePower / 1000), 'kvar', params.reactiveType === 'lagging' ? '感性：取正号' : '容性：取负号')
        + metric('视在功率 S', format(result.apparentPower / 1000), 'kVA', 'S² = P² + Q²');
      drawPowerChart(params, result);
    } else {
      $('#fault-results').innerHTML = metric('三相短路电流 Iₖ', format(result.shortCircuitCurrentA / 1000), 'kA', '交流对称分量有效值', true)
        + metric('额定电流 Iₙ', format(result.ratedCurrentA), 'A', '低压侧线电流')
        + metric('总阻抗 zΣ*', format(result.totalImpedancePu, 4), 'p.u.', `短路容量 ${format(result.shortCircuitCapacityMva)} MVA`);
      $('#source-note').textContent = params.sourceShortCircuitMva === null ? '无限大电源' : `Ssc = ${format(params.sourceShortCircuitMva)} MVA`;
      $('#transformer-note').textContent = `uₖ = ${format(params.impedancePercent)}%`;
      $('#fault-note').textContent = `Iₖ = ${format(result.shortCircuitCurrentA / 1000)} kA`;
      $('#use-fault-current').disabled = false;
    }
  } catch (failure) {
    results[view] = null;
    error.textContent = failure instanceof RangeError ? failure.message : '计算未能完成，请检查参数。';
    $(`#${view}-results`).innerHTML = metric('等待有效参数', '—', '', '请修正左侧输入');
    if (view === 'fault') {
      $('#use-fault-current').disabled = true;
      $('#source-note').textContent = '—';
      $('#transformer-note').textContent = '—';
      $('#fault-note').textContent = '—';
    } else {
      $(`#${view}-chart`).innerHTML = '<text x="360" y="155" text-anchor="middle" fill="#9ba58f" font-size="14">输入有效参数后显示图形</text>';
      if (view === 'power') $('#power-caption').textContent = '';
    }
  }
}

function readQuizProgress() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!stored || Array.isArray(stored) || typeof stored !== 'object') return {};
    const clean = {};
    for (const question of QUESTIONS) {
      if (Number.isInteger(stored[question.id]) && stored[question.id] >= 0 && stored[question.id] < question.options.length) clean[question.id] = stored[question.id];
    }
    return clean;
  } catch { return {}; }
}
let answers = readQuizProgress();

function saveQuiz() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(answers)); }
  catch { $('#storage-note').textContent = '浏览器不允许本地存储，本次进度仅在当前页面保留。'; }
}

function renderQuiz(focus = false) {
  const question = QUESTIONS[quizIndex];
  const answered = Object.hasOwn(answers, question.id);
  $('#quiz-topic').textContent = question.topic;
  $('#quiz-position').textContent = `${String(quizIndex + 1).padStart(2, '0')} / ${QUESTIONS.length}`;
  $('#quiz-progress').style.width = `${(quizIndex + 1) / QUESTIONS.length * 100}%`;
  $('#quiz-prompt').textContent = question.prompt;
  const options = $('#quiz-options');
  options.replaceChildren();
  question.options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiz-option';
    button.disabled = answered;
    if (answered && index === question.answer) button.classList.add('correct');
    if (answered && answers[question.id] === index && index !== question.answer) button.classList.add('incorrect');
    const letter = document.createElement('span');
    letter.textContent = 'ABCD'[index];
    const content = document.createElement('div');
    content.textContent = option;
    button.append(letter, content);
    button.addEventListener('click', () => { answers[question.id] = index; saveQuiz(); renderQuiz(); $('#quiz-next').focus({ preventScroll: true }); });
    options.append(button);
  });
  const feedback = $('#quiz-feedback');
  feedback.hidden = !answered;
  feedback.replaceChildren();
  if (answered) {
    const title = document.createElement('strong');
    title.textContent = answers[question.id] === question.answer ? '✓ 回答正确' : `再理解一下 · 正确答案 ${'ABCD'[question.answer]}`;
    const explanation = document.createElement('span');
    explanation.textContent = question.explanation;
    feedback.append(title, explanation);
  }
  const correct = QUESTIONS.filter((q) => answers[q.id] === q.answer).length;
  const done = Object.keys(answers).length;
  $('#quiz-score').textContent = String(correct);
  $('#quiz-status').textContent = done === QUESTIONS.length ? `已完成全部 ${done} 题，答对 ${correct} 题。可以点击题号回看解析。` : `已完成 ${done} / ${QUESTIONS.length} 题。每道题都附有原理解析。`;
  $('#quiz-prev').disabled = quizIndex === 0;
  $('#quiz-next').textContent = quizIndex === QUESTIONS.length - 1 ? '回到第一题 ↺' : '下一题 →';
  const dots = $('#quiz-dots');
  dots.replaceChildren();
  QUESTIONS.forEach((q, i) => {
    const button = document.createElement('button');
    button.className = 'quiz-dot';
    if (Object.hasOwn(answers, q.id)) button.classList.add(answers[q.id] === q.answer ? 'correct' : 'incorrect');
    if (i === quizIndex) button.classList.add('current');
    button.textContent = String(i + 1);
    button.setAttribute('aria-label', `第 ${i + 1} 题${Object.hasOwn(answers, q.id) ? answers[q.id] === q.answer ? '，答对' : '，答错' : '，未答'}`);
    if (i === quizIndex) button.setAttribute('aria-current', 'step');
    button.addEventListener('click', () => { quizIndex = i; renderQuiz(true); });
    dots.append(button);
  });
  if (focus) $('#quiz-prompt').focus({ preventScroll: true });
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
window.addEventListener('hashchange', () => {
  const view = location.hash.slice(1);
  if (Object.hasOwn(labels, view)) switchView(view, false);
});
for (const view of ['relay', 'power', 'fault']) {
  const form = $(`#${view}-form`);
  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('input', () => update(view));
  form.addEventListener('change', () => update(view));
  $(`#reset-${view}`).addEventListener('click', () => { form.reset(); update(view); });
  update(view);
}

$('#use-fault-current').addEventListener('click', () => {
  if (!results.fault) return;
  $('#relay-current').value = String(results.fault.result.shortCircuitCurrentA);
  update('relay');
  switchView('relay');
  showToast('已传入低压侧一次短路电流，请核对启动电流基准。');
});
$('#quiz-prev').addEventListener('click', () => { quizIndex = Math.max(0, quizIndex - 1); renderQuiz(true); });
$('#quiz-next').addEventListener('click', () => { quizIndex = (quizIndex + 1) % QUESTIONS.length; renderQuiz(true); });
$('#quiz-reset').addEventListener('click', () => { answers = {}; quizIndex = 0; saveQuiz(); renderQuiz(true); showToast('答题进度已重置。'); });
$('#export-report').addEventListener('click', () => {
  const invalid = ['relay', 'power', 'fault'].filter((key) => !results[key]);
  if (invalid.length) { showToast(`请先修正${invalid.map((key) => labels[key]).join('、')}中的参数，再导出报告。`); return; }
  const report = {
    project: 'GridLab', version: '1.0.0', generatedAt: new Date().toISOString(), activeModule: activeView,
    units: { power: { apparentPower: 'VA', activePower: 'W', reactivePower: 'var', phaseAngleDeg: 'degree' }, fault: { ratedCurrentA: 'A', shortCircuitCurrentA: 'A', shortCircuitCapacityMva: 'MVA', totalImpedancePu: 'p.u.' }, relay: { currentA: 'A', pickupA: 'A', operatingTimeS: 's' } },
    assumptions: ['对称正弦三相负载，采用被动负载约定。', '短路模型将同角度阻抗幅值相加，忽略线路、电动机与暂态；不是 IEC 60909 完整实现。', '继电器为理想静态曲线，不含装置容差、最短动作时间和断路器分闸时间。'],
    experiments: results,
    quiz: { answered: Object.keys(answers).length, correct: QUESTIONS.filter((q) => answers[q.id] === q.answer).length, total: QUESTIONS.length },
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `gridlab-report-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast('实验报告已生成，包含参数、结果、单位和模型假设。');
});

renderQuiz();
switchView(location.hash.slice(1) || 'relay', false);
