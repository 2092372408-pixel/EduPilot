/**
 * Parameterised, trusted exercise families.
 * Models do not author the judge, reference solution or expected outputs.
 * All generated tasks are validated by executing a reference and counterexamples.
 */
const { createHash } = require('node:crypto');
const { gradeProblem } = require('./grader');

const TEMPLATE_VERSION = 1;
const FAMILIES = [
  { id: 'parity', kpId: 'kp3', title: '分支与奇偶判断', titleEn: 'Branches and parity',
    description: '根据输入奇偶选择不同运算，检查零和负数。', descriptionEn: 'Choose a transformation by parity, including zero and negative inputs.' },
  { id: 'loop-sum', kpId: 'kp4', title: '循环边界与求和', titleEn: 'Loop bounds and sums',
    description: '使用循环计算指定闭区间，处理空区间与端点。', descriptionEn: 'Sum a closed interval using a loop, including empty intervals and endpoints.' },
  { id: 'function-return', kpId: 'kp5', title: '函数返回与输入变化', titleEn: 'Function returns and changing inputs',
    description: '让函数根据两个输入计算并返回结果。', descriptionEn: 'Compute and return a result from two changing inputs.' },
];
const choose = (lang, zh, en) => lang === 'en' ? en : zh;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function listFamilies() { return FAMILIES.map(f => ({ ...f })); }
function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_VARIANT' }); }

function createVariant(familyId, seed, options = {}) {
  const family = FAMILIES.find(f => f.id === familyId);
  if (!family) throw invalid('Unknown exercise family');
  const purpose = options.purpose || 'practice';
  if (!['practice', 'transfer'].includes(purpose)) throw invalid('Unknown exercise purpose');
  if (seed === null || seed === undefined || !String(seed).length || String(seed).length > 200) throw invalid('A non-empty seed of at most 200 characters is required');
  const lang = options.lang === 'en' ? 'en' : 'zh';
  const bytes = createHash('sha256').update(String(seed)).digest();
  const transfer = purpose === 'transfer';
  const txt = (zh, en) => choose(lang, zh, en);
  const descriptionFor = (zh, en) => ({ desc: txt(zh, en), descEn: en });
  const rule = (id, nodes, fn, diagnosisId, zh, en) => ({
    id, kind: 'require_node', nodes, function: fn, diagnosisId, ...descriptionFor(zh, en),
  });
  const resultCase = (id, fn, args, expected, zh, en) => ({
    id, kind: 'return', function: fn, args, expected, ...descriptionFor(zh, en),
  });
  let parameters, title, description, starterCode, referenceCode, publicExamples, constraints, judgeSpec, mutants;
  if (familyId === 'parity') {
    const evenDelta = (transfer ? -1 : 1) * (2 + bytes[0] % 9);
    const oddDelta = (transfer ? 1 : -1) * (2 + bytes[1] % 9);
    parameters = { evenDelta, oddDelta };
    const fn = 'classify_parity';
    const even = 2 * (2 + bytes[2] % 12), odd = even + 1;
    const expected = n => n + (n % 2 === 0 ? evenDelta : oddDelta);
    title = txt('按奇偶转换数值', 'Transform a number by parity');
    description = txt(
      '定义函数 classify_parity(n)，n 是整数。n 为偶数时返回 n + (' + evenDelta + ')，为奇数时返回 n + (' + oddDelta + ')。使用 if/else 或条件表达式进行分支。返回计算结果，不要只打印；输入可能为零或负数。',
      'Define classify_parity(n) for integer n. Return n + (' + evenDelta + ') for even n and n + (' + oddDelta + ') for odd n. Use if/else or a conditional expression. Return the result instead of only printing it. Inputs may be zero or negative.');
    starterCode = 'def classify_parity(n):\n    # ' + txt('根据输入选择分支并返回结果', 'Choose a branch and return the result') + '\n    pass\n';
    referenceCode = 'def classify_parity(n):\n    if n % 2 == 0:\n        return n + (' + evenDelta + ')\n    return n + (' + oddDelta + ')\n';
    constraints = [txt('使用条件分支；必须返回结果。', 'Use a conditional branch and return the result.'),
      txt('处理任意整数，包括零和负数。', 'Handle integer inputs, including zero and negative values.')];
    publicExamples = [even, odd].map(n => ({ input: fn + '(' + n + ')', output: String(expected(n)) }));
    judgeSpec = { constraints: [rule('use-branch', ['If', 'IfExp'], fn, 'branch_missing', '在函数中使用条件分支', 'Use a conditional branch in the function')], cases: [
      resultCase('negative-odd', fn, [-7], expected(-7), '负奇数输入', 'Negative odd input'),
      resultCase('negative-even', fn, [-2], expected(-2), '负偶数输入', 'Negative even input'),
      resultCase('zero', fn, [0], expected(0), '零输入', 'Zero input'),
      resultCase('positive-odd', fn, [1], expected(1), '正奇数输入', 'Positive odd input'),
      resultCase('positive-even', fn, [2], expected(2), '正偶数输入', 'Positive even input'),
      resultCase('example-even', fn, [even], expected(even), '公开偶数样例', 'Public even example'),
      resultCase('example-odd', fn, [odd], expected(odd), '公开奇数样例', 'Public odd example'),
    ] };
    mutants = [
      { id: 'starter', code: starterCode },
      { id: 'constant', code: 'def classify_parity(n):\n    return ' + expected(even) + '\n' },
      { id: 'reversed-branches', code: 'def classify_parity(n):\n    if n % 2 == 0:\n        return n + (' + oddDelta + ')\n    return n + (' + evenDelta + ')\n' },
      { id: 'zero-special-case', code: referenceCode.replace('    if n % 2', '    if n == 0:\n        return ' + (expected(0) + 1) + '\n    if n % 2') },
      { id: 'negative-special-case', code: referenceCode.replace('    if n % 2', '    if n < 0:\n        return 0\n    if n % 2') },
    ];
  } else if (familyId === 'loop-sum') {
    const start = (transfer ? 6 : 1) + bytes[0] % (transfer ? 8 : 5);
    const weight = 1 + bytes[1] % 4;
    parameters = { start, weight };
    const fn = 'sum_interval', sample = start + 2 + bytes[2] % 5;
    const expected = n => n < start ? 0 : weight * (start + n) * (n - start + 1) / 2;
    title = txt('计算指定区间的加权和', 'Sum a weighted interval');
    description = txt(
      '定义 sum_interval(n)。使用 for 循环逐项更新累加器，把从 ' + start + ' 到 n（包含两个端点）的每个整数乘以 ' + weight + ' 后相加，并返回累加结果。也可以先累加、最后乘倍数。n 小于 ' + start + ' 时返回 0。不使用 sum() 或它的别名，也不要把自定义变量或函数命名为 sum；必须返回结果，不要只打印。',
      'Define sum_interval(n). Use a for loop to update an accumulator for each integer from ' + start + ' through n (both endpoints included), multiplied by ' + weight + ', and return the accumulated result. You may apply the multiplier after the loop. Return 0 when n is below ' + start + '. Do not use sum() or an alias, and do not name your own variables or functions sum. Return the result instead of only printing it.');
    starterCode = 'def sum_interval(n):\n    # ' + txt('使用循环累加并返回结果', 'Accumulate with a loop and return the result') + '\n    pass\n';
    referenceCode = 'def sum_interval(n):\n    total = 0\n    for value in range(' + start + ', n + 1):\n        total += value * ' + weight + '\n    return total\n';
    constraints = [txt('用 for 逐项更新累加器，返回累加得到的结果。', 'Use a for loop to update an accumulator and return that result.'),
      txt('不使用 sum、其别名或同名自定义变量/函数。', 'Do not use sum, an alias, or a custom variable/function with that name.'),
      txt('包含区间两端，空区间返回 0。', 'Include both endpoints; return 0 for an empty interval.')];
    publicExamples = [{ input: fn + '(' + sample + ')', output: String(expected(sample)) },
      { input: fn + '(' + (start - 1) + ')', output: '0' }];
    judgeSpec = { constraints: [
      { id: 'use-for', kind: 'loop_accumulator', function: fn,
        ...descriptionFor('用实际执行的 for 循环累加并返回结果', 'Return a result accumulated by an executed for loop') },
      { id: 'no-sum', kind: 'forbid_call', names: ['sum'], diagnosisId: 'constraint_violation', ...descriptionFor('不调用 sum()', 'Do not call sum()') },
    ], cases: [
      resultCase('empty-negative', fn, [-2], 0, '负数形成的空区间', 'Empty interval with a negative upper bound'),
      resultCase('empty-boundary', fn, [start - 1], 0, '起点前的空区间', 'Empty interval just before the start'),
      resultCase('single-point', fn, [start], expected(start), '仅有一个端点的区间', 'Single-point interval'),
      resultCase('two-points', fn, [start + 1], expected(start + 1), '连续两个端点', 'Two consecutive values'),
      resultCase('example', fn, [sample], expected(sample), '公开非空区间样例', 'Public non-empty example'),
      resultCase('longer-interval', fn, [start + 12 + bytes[3] % 10], expected(start + 12 + bytes[3] % 10), '不同长度的区间', 'An interval of a different length'),
    ] };
    mutants = [
      { id: 'starter', code: starterCode },
      { id: 'constant', code: 'def sum_interval(n):\n    for value in []:\n        pass\n    return ' + expected(sample) + '\n' },
      { id: 'exclusive-end', code: referenceCode.replace('n + 1', 'n') },
      { id: 'skipped-start', code: referenceCode.replace('range(' + start + ',', 'range(' + (start + 1) + ',') },
      { id: 'wrong-weight', code: referenceCode.replace('value * ' + weight, 'value * ' + (weight + 1)) },
      { id: 'forbidden-sum', code: 'def sum_interval(n):\n    return sum(value * ' + weight + ' for value in range(' + start + ', n + 1))\n' },
      { id: 'empty-loop-formula', code: 'def sum_interval(n):\n    total = 0\n    for value in []:\n        total += value\n    if n < ' + start + ':\n        return 0\n    return total + (' + start + ' + n) * (n - ' + start + ' + 1) // 2 * ' + weight + '\n' },
      { id: 'pass-loop-indirect-sum', code: 'def sum_interval(n):\n    for value in range(' + start + ', n + 1):\n        pass\n    return [sum][0](range(' + start + ', n + 1)) * ' + weight + '\n' },
    ];
  } else {
    const alpha = (transfer ? -1 : 1) * (2 + bytes[0] % 5), beta = 1 + bytes[1] % 5;
    parameters = { alpha, beta };
    const fn = 'combine', first = 2 + bytes[2] % 7, second = 1 + bytes[3] % 6;
    const expected = (a, b) => alpha * a + beta * b;
    title = txt('返回两个输入的线性组合', 'Return a combination of two inputs');
    description = txt(
      '定义 combine(a, b)，返回 (' + alpha + ') × a + (' + beta + ') × b。a、b 都是整数，可能为零或负数。函数要返回结果，打印结果不能替代 return。',
      'Define combine(a, b) to return (' + alpha + ') × a + (' + beta + ') × b. Both inputs are integers and may be zero or negative. The function must return its result; printing is not a substitute for returning.');
    starterCode = 'def combine(a, b):\n    # ' + txt('计算并返回结果', 'Compute and return the result') + '\n    pass\n';
    referenceCode = 'def combine(a, b):\n    return (' + alpha + ') * a + (' + beta + ') * b\n';
    constraints = [txt('通过 return 返回结果；支持不同输入。', 'Return the result and handle different inputs.')];
    publicExamples = [[first, second], [0, second]].map(args => ({ input: fn + '(' + args.join(', ') + ')', output: String(expected(...args)) }));
    judgeSpec = { constraints: [], cases: [
      resultCase('both-zero', fn, [0, 0], 0, '两个输入都为零', 'Both inputs are zero'),
      resultCase('first-only', fn, [1, 0], alpha, '仅第一个输入非零', 'Only the first input is non-zero'),
      resultCase('second-only', fn, [0, 1], beta, '仅第二个输入非零', 'Only the second input is non-zero'),
      resultCase('mixed-signs', fn, [-3, 2], expected(-3, 2), '第一个输入为负数', 'A negative first input'),
      resultCase('reversed-signs', fn, [2, -3], expected(2, -3), '第二个输入为负数', 'A negative second input'),
      resultCase('both-negative', fn, [-2, -4], expected(-2, -4), '两个输入都为负数', 'Both inputs are negative'),
      resultCase('example', fn, [first, second], expected(first, second), '公开样例', 'Public example'),
    ] };
    mutants = [
      { id: 'starter', code: starterCode },
      { id: 'print-only', code: 'def combine(a, b):\n    print((' + alpha + ') * a + (' + beta + ') * b)\n' },
      { id: 'constant', code: 'def combine(a, b):\n    return ' + expected(first, second) + '\n' },
      { id: 'wrong-operator', code: 'def combine(a, b):\n    return (' + alpha + ') * a - (' + beta + ') * b\n' },
      { id: 'missing-term', code: 'def combine(a, b):\n    return (' + alpha + ') * a\n' },
      { id: 'absolute-inputs', code: 'def combine(a, b):\n    return (' + alpha + ') * abs(a) + (' + beta + ') * abs(b)\n' },
    ];
  }
  // Novelty follows the task's mathematical requirement, not a changed public
  // example or hidden input. Reusing the same solution is not an unseen task.
  const variantKey = hash([TEMPLATE_VERSION, familyId, parameters]).slice(0, 24);
  return { id: 'variant-' + hash([variantKey, String(seed), purpose]).slice(0, 20),
    familyId, kpId: family.kpId, title, description, starterCode,
    difficulty: txt('入门', 'Beginner'), templateVersion: TEMPLATE_VERSION,
    seed: String(seed), purpose, lang, variantKey, parameters,
    publicExamples, constraints, referenceCode, judgeSpec, mutants,
    testCases: [...judgeSpec.constraints, ...judgeSpec.cases].map(({ id, desc, descEn }) => ({ id, desc, descEn })) };
}

/** Explicit allowlist. Hidden inputs, expected values, references and seeds stay server-side. */
function publicVariant(problem) {
  if (!problem || !FAMILIES.some(f => f.id === problem.familyId)) throw invalid('Unknown exercise family');
  const keys = ['id', 'familyId', 'kpId', 'title', 'description', 'starterCode', 'difficulty',
    'templateVersion', 'purpose', 'lang'];
  return { ...Object.fromEntries(keys.map(key => [key, problem[key]])),
    publicExamples: (problem.publicExamples || []).map(({ input, output }) => ({ input, output })),
    constraints: [...(problem.constraints || [])],
    testCases: (problem.testCases || []).map(({ desc }) => ({ desc })) };
}

async function validateVariant(problem) {
  if (!problem?.referenceCode || !Array.isArray(problem.mutants) || !problem.mutants.length) throw invalid('Variant is missing validation programs');
  const reference = await gradeProblem(problem, problem.referenceCode, { review: false });
  const checks = [{ id: 'reference', kind: 'reference', passed: reference.passed,
    total: reference.total, ok: !reference.error && reference.passed === reference.total,
    ...(reference.error ? { error: reference.error } : {}) }];
  let rejected = 0;
  if (checks[0].ok) {
    // Keep validation bounded; each candidate still goes through both static guards.
    for (const mutant of problem.mutants) {
      const grade = await gradeProblem(problem, mutant.code, { review: false });
      const ok = !grade.error && grade.total > 0 && grade.passed < grade.total;
      if (ok) rejected++;
      checks.push({ id: mutant.id, kind: 'counterexample', passed: grade.passed, total: grade.total,
        ok, diagnosisId: grade.diagnosisId, ...(grade.error ? { error: grade.error } : {}) });
    }
  }
  return { ok: checks[0].ok && rejected === problem.mutants.length,
    referencePassed: reference.passed, referenceTotal: reference.total,
    mutantsRejected: rejected, mutantsTotal: problem.mutants.length, checks };
}

function getHints(problem, diagnosisId, lang = problem?.lang || 'zh') {
  const fn = problem?.familyId;
  const packs = {
    parity: [
      ['先区分当前输入是奇数还是偶数，零也属于其中一类。', 'First decide whether the input is odd or even; zero also belongs to a class.'],
      ['把两个分支各自应做的运算写在纸上，核对是否交换了分支。', 'Write down the transformation for each branch and check that they are not reversed.'],
      ['分别手算一个正偶数、一个负奇数和零，再与失败用例逐项比较；检查每条分支是否返回结果。', 'Trace a positive even number, a negative odd number and zero, then compare each failed case. Check that every branch returns a value.'],
    ],
    'loop-sum': [
      ['把题目要求包含的起点和终点写出来，先想只有一个数时应怎样累加。', 'Write down both included endpoints and consider an interval containing just one value.'],
      ['检查 range 的停止值是否会被执行，以及每次累加是否用了题目要求的倍数。', 'Check whether the stopping value of range is visited and whether each addition uses the required multiplier.'],
      ['分别跟踪空区间、单点区间和两个数的区间；观察累加器初值、最后一轮以及循环结束后的返回值。', 'Trace an empty interval, a one-value interval and a two-value interval. Inspect the initial accumulator, final iteration and return after the loop.'],
    ],
    'function-return': [
      ['打印给屏幕看的内容，与调用者收到的返回值，是两个不同的检查对象。', 'Printed output and the value received by the caller are different things.'],
      ['先令其中一个输入为零，分别检查另一个输入对应的系数；再交换检查。', 'Set one input to zero to check the coefficient of the other, then swap them.'],
      ['用一组带负数的新输入手算两项，再检查运算符和 return；不要把某个样例的结果写成固定答案。', 'Calculate both terms for new inputs containing a negative value. Check the operator and return statement; do not hard-code an example result.'],
    ],
  };
  const pack = packs[fn] || [
    ['先阅读实际失败用例。', 'Start with the actual failing case.'],
    ['对照题目要求检查输入、输出和返回值。', 'Compare the inputs, printed output and return value with the task.'],
    ['用一个更小的输入逐步检查，不要直接替换为固定答案。', 'Trace a smaller input rather than replacing the result with a constant.'],
  ];
  const hints = pack.map(pair => pair[lang === 'en' ? 1 : 0]);
  if (diagnosisId === 'return_missing') hints[0] = choose(lang,
    '先检查函数是否通过 return 交回结果；仅打印不会给调用者返回这个数。', 'Check that the function returns its result; printing alone does not return the number to its caller.');
  if (diagnosisId === 'branch_missing') hints[0] = choose(lang,
    '题目明确要求条件分支，先把两种输入情况分别列出来。', 'The task explicitly requires a conditional branch. List the two input cases first.');
  if (diagnosisId === 'loop_missing') hints[0] = choose(lang,
    '题目要求使用 for 循环，先确定需要逐个访问哪些整数。', 'The task requires a for loop. Identify which integers must be visited.');
  if (diagnosisId === 'hardcoded') hints[0] = choose(lang,
    '当前函数返回固定常量。先选两个结果应不同的输入，观察它们是否仍得到同一个数。', 'The current function returns a constant. Compare two inputs that should have different results.');
  return hints;
}

module.exports = { listFamilies, createVariant, validateVariant, publicVariant, getHints, TEMPLATE_VERSION };
