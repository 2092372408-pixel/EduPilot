/**
 * coding/problems.js — 编程实践题数据（每单元 1 道，带测试用例）
 * 测试用例：check 为布尔表达式字符串（在用户代码之后求值），desc 展示给前端。
 * 注意：check 是内部字段，对外 API 只暴露 desc，避免学生直接抄答案。
 */

const PROBLEMS = [
  {
    id: 'kp1-1',
    kpId: 'kp1',
    title: '变量交换',
    difficulty: '入门',
    description: '给定 `a = 1`、`b = 2`，请编写代码交换它们的值，使最终 `a == 2` 且 `b == 1`。\n提示：可以借助第三个变量 `temp`。',
    starterCode: 'a = 1\nb = 2\n# 在这里编写交换代码\n',
    testCases: [
      { check: 'a == 2 and b == 1', desc: '交换后 a=2, b=1' },
      { check: 'a != b', desc: 'a 与 b 不再相等' },
    ],
  },
  {
    id: 'kp2-1',
    kpId: 'kp2',
    title: '类型判断输出',
    difficulty: '入门',
    description: '定义变量 `x = 3.14`，请打印：①它的类型名（用 `type(x).__name__`）；②转成整数后的值。\n输出格式：两行，第一行类型名，第二行整数。',
    starterCode: 'x = 3.14\n# 在这里编写代码\n',
    testCases: [
      { check: "type(x).__name__ == 'float'", desc: 'x 的类型是 float' },
      { check: 'int(x) == 3', desc: '转整数后为 3' },
    ],
  },
  {
    id: 'kp3-1',
    kpId: 'kp3',
    title: '奇偶判断',
    difficulty: '入门',
    description: '给定变量 `n = 7`，请用 `if/else` 判断：`n` 是偶数打印 `"偶数"`，是奇数打印 `"奇数"`。',
    starterCode: 'n = 7\n# 在这里编写代码\n',
    testCases: [
      { check: "n % 2 != 0", desc: '7 是奇数' },
    ],
  },
  {
    id: 'kp4-1',
    kpId: 'kp4',
    title: '1 到 100 求和',
    difficulty: '入门',
    description: '用 `for` 循环计算 `1 + 2 + ... + 100` 的和，存入变量 `total`，并打印出来。',
    starterCode: '# 在这里编写代码\ntotal = 0\n',
    testCases: [
      { check: 'total == 5050', desc: '总和为 5050' },
    ],
  },
  {
    id: 'kp5-1',
    kpId: 'kp5',
    title: '定义加法函数',
    difficulty: '入门',
    description: '定义一个函数 `add(a, b)`，返回 `a + b` 的结果。\n然后调用 `add(3, 4)` 并打印返回值。',
    starterCode: '# 在这里编写代码\n',
    testCases: [
      { check: 'add(3, 4) == 7', desc: 'add(3,4) 返回 7' },
      { check: 'add(10, -2) == 8', desc: 'add(10,-2) 返回 8' },
    ],
  },
  {
    id: 'kp6-1',
    kpId: 'kp6',
    title: '列表最大值',
    difficulty: '进阶',
    description: '给定列表 `nums = [3, 8, 1, 6, 9, 2]`，请找出其中的最大值，存入变量 `max_val` 并打印。\n（不允许使用内置 `max()` 函数）',
    starterCode: 'nums = [3, 8, 1, 6, 9, 2]\n# 在这里编写代码\n',
    testCases: [
      { check: 'max_val == 9', desc: '最大值为 9' },
    ],
  },
  {
    id: 'kp7-1',
    kpId: 'kp7',
    title: '定义 Dog 类',
    difficulty: '进阶',
    description: '定义一个类 `Dog`：\n①构造方法接收 `name` 并存入 `self.name`；\n②方法 `bark()` 返回字符串 `"汪汪"`。\n然后创建 `d = Dog("旺财")`，调用 `d.bark()` 存入 `sound`。',
    starterCode: '# 在这里编写代码\n',
    testCases: [
      { check: "Dog('旺财').name == '旺财'", desc: 'name 属性正确' },
      { check: "Dog('x').bark() == '汪汪'", desc: 'bark() 返回 汪汪' },
    ],
  },
];

/** 某单元的公开题目列表（不含测试检查表达式） */
function getProblems(kpId) {
  return PROBLEMS
    .filter((p) => p.kpId === kpId)
    .map(({ id, kpId, title, difficulty, description, starterCode, testCases }) => ({
      id, kpId, title, difficulty, description, starterCode,
      testCases: testCases.map((t) => ({ desc: t.desc })),
    }));
}

function getProblem(problemId) {
  return PROBLEMS.find((p) => p.id === problemId) || null;
}

module.exports = { PROBLEMS, getProblems, getProblem };
