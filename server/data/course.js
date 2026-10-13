/**
 * course.js — 课程知识库（领域数据层）
 * ------------------------------------------------------------
 * 智能体的"知识底座"：课程 → 章节 → 知识点 → 讲解/要点/示例/误区/练习
 * 实际产品中，这部分数据通常来自教材解析、知识图谱或课程平台 API。
 * 这里内置一份《Python 编程入门》示例课程，方便你直接体验完整流程。
 */

const course = {
  id: 'python-intro',
  title: 'Python 编程入门',
  description: '零基础入门 Python，掌握变量、流程控制、函数、数据结构与面向对象。',
  chapters: [
    {
      id: 'ch1',
      title: '第一章 变量与数据类型',
      knowledgePoints: [
        {
          id: 'kp1',
          title: '变量与赋值',
          summary: '变量是给数据起名字的容器，赋值用等号 =，Python 是动态类型语言。',
          keyPoints: [
            '变量名只能包含字母、数字、下划线，且不能以数字开头',
            '赋值运算符 = 表示"把右边的值绑定到左边的名字"',
            'Python 变量无需声明类型，类型由赋值自动推断（动态类型）',
            '变量可以重新赋值，新值会覆盖旧值'
          ],
          example: '```python\n# 变量赋值\nname = "小明"\nage = 18\nage = 19  # 重新赋值\nprint(name, age)  # 输出：小明 19\n```',
          pitfalls: [
            '误区：a = b 是"复制"，实际上是把 b 当前的值赋给 a，之后两者互不影响',
            '误区：变量名用中文或特殊符号（如 2name、my-name）会报错',
            '注意：print 里逗号分隔会自动加空格'
          ],
          quiz: [
            {
              q: '下面哪个是合法的变量名？',
              options: ['2name', 'my-name', 'my_name', 'my name'],
              answer: 'C',
              explanation: '变量名不能以数字开头（A），不能包含连字符（B）和空格（D），下划线可以（C）。'
            },
            {
              q: '执行 a = 5; b = a; a = 10 后，b 的值是？',
              options: ['5', '10', '报错', '15'],
              answer: 'A',
              explanation: 'b = a 是在该时刻把 a 的值 5 赋给 b，之后 a 变成 10 不影响 b。'
            },
            {
              q: 'Python 中变量是否需要声明类型？',
              options: ['需要，如 int x = 5', '不需要，类型自动推断', '需要，但可省略', '只有字符串需要声明'],
              answer: 'B',
              explanation: 'Python 是动态类型语言，x = 5 会自动推断为整数。'
            }
          ]
        },
        {
          id: 'kp2',
          title: '常见数据类型',
          summary: 'Python 内置 int、float、str、bool 四种基础类型，用 type() 可查看类型。',
          keyPoints: [
            'int 整数、float 浮点数、str 字符串、bool 布尔值（True/False）',
            '字符串用单引号或双引号包裹：\'hi\' 或 "hi"',
            'type() 函数可以查看变量的类型',
            '字符串拼接用 +，数字运算用 +，两者不能混用'
          ],
          example: '```python\nx = 10        # int\npi = 3.14     # float\nname = "AI"   # str\nok = True     # bool\nprint(type(x))  # <class \'int\'>\nprint("你好" + name)  # 你好AI\n```',
          pitfalls: [
            '误区：1 + "1" 会报错，不同类型不能直接相加，需用 int() 或 str() 转换',
            '注意：布尔值首字母大写 True/False，小写 true 会报错'
          ],
          quiz: [
            {
              q: 'type(3.14) 的结果是？',
              options: ['<class \'int\'>', '<class \'float\'>', '<class \'str\'>', '<class \'bool\'>'],
              answer: 'B',
              explanation: '3.14 是浮点数，type() 返回 <class \'float\'>。'
            },
            {
              q: '执行 "3" + 5 会发生什么？',
              options: ['得到 8', '得到 "35"', '报 TypeError 错误', '得到 35'],
              answer: 'C',
              explanation: '字符串和整数不能直接相加，Python 会抛出 TypeError。'
            }
          ]
        }
      ]
    },
    {
      id: 'ch2',
      title: '第二章 流程控制',
      knowledgePoints: [
        {
          id: 'kp3',
          title: '条件判断 if / elif / else',
          summary: 'if 语句让程序根据不同条件执行不同分支，注意冒号和缩进。',
          keyPoints: [
            'if 条件后必须加冒号 :，下一行必须缩进（通常 4 个空格）',
            'elif 是 else if 的缩写，可以连续使用',
            '比较运算符：== 相等、!= 不等、>、<、>=、<=',
            '逻辑运算符：and（且）、or（或）、not（非）'
          ],
          example: '```python\nscore = 85\nif score >= 90:\n    print("优秀")\nelif score >= 60:\n    print("及格")\nelse:\n    print("不及格")\n# 输出：及格\n```',
          pitfalls: [
            '误区：判断相等要用 ==，单个 = 是赋值，写错不会报错但逻辑全错',
            '误区：忘记冒号或缩进不一致会直接报 IndentationError'
          ],
          quiz: [
            {
              q: '判断两个值是否相等应该用哪个运算符？',
              options: ['=', '==', '===', ':='],
              answer: 'B',
              explanation: 'Python 中 == 判断相等，= 是赋值，没有 === 运算符。'
            },
            {
              q: 'if 语句体必须满足什么要求？',
              options: ['使用花括号括起来', '末尾加分号', '下一行缩进，条件后加冒号', '必须使用 else'],
              answer: 'C',
              explanation: 'Python 用冒号 + 缩进表示代码块，不依赖花括号。'
            }
          ]
        },
        {
          id: 'kp4',
          title: '循环 for / while',
          summary: 'for 遍历序列，while 按条件循环，break 跳出循环，continue 跳过本次。',
          keyPoints: [
            'for 变量 in 序列：遍历列表、字符串、range() 等可迭代对象',
            'range(5) 生成 0~4，range(1, 5) 生成 1~4',
            'while 条件: 当条件为真时一直执行，注意防止死循环',
            'break 立即结束循环；continue 跳过本次循环继续下一次'
          ],
          example: '```python\n# for 遍历\nfor i in range(3):\n    print(i)  # 0 1 2\n\n# while 循环\nn = 3\nwhile n > 0:\n    print(n)\n    n -= 1  # 输出 3 2 1\n```',
          pitfalls: [
            '误区：while 循环忘记更新条件变量，会造成死循环',
            '误区：range(5) 不包含 5，想取到 5 要用 range(6)'
          ],
          quiz: [
            {
              q: 'range(5) 生成哪些数字？',
              options: ['1,2,3,4,5', '0,1,2,3,4', '0,1,2,3,4,5', '1,2,3,4'],
              answer: 'B',
              explanation: 'range(n) 生成 0 到 n-1，所以 range(5) 是 0,1,2,3,4。'
            },
            {
              q: 'break 语句的作用是？',
              options: ['跳过本次循环', '结束整个循环', '退出程序', '跳到下一行代码'],
              answer: 'B',
              explanation: 'break 立即终止整个循环；continue 才是跳过本次进入下一次。'
            }
          ]
        }
      ]
    },
    {
      id: 'ch3',
      title: '第三章 函数',
      knowledgePoints: [
        {
          id: 'kp5',
          title: '函数定义与调用',
          summary: '函数用 def 定义，封装可复用的代码块，支持参数和返回值。',
          keyPoints: [
            'def 函数名(参数): 定义函数，函数体需要缩进',
            'return 返回结果，没有 return 时函数返回 None',
            '参数可以设置默认值：def greet(name="同学")',
            '函数必须先定义再调用'
          ],
          example: '```python\ndef greet(name):\n    return "你好，" + name\n\nmsg = greet("小明")\nprint(msg)  # 你好，小明\n\ndef add(a, b=1):\n    return a + b\n\nprint(add(5))    # 6（b 用默认值）\nprint(add(5, 3)) # 8\n```',
          pitfalls: [
            '误区：函数没有 return 时以为返回"空"，实际返回 None',
            '注意：参数按位置传入，默认值参数要放在后面'
          ],
          quiz: [
            {
              q: '一个没有 return 的函数，调用后返回什么？',
              options: ['0', '空字符串', 'None', '报错'],
              answer: 'C',
              explanation: '没有 return 的函数默认返回 None。'
            },
            {
              q: 'def f(a, b=2): return a + b，f(3) 的结果是？',
              options: ['5', '报错', '2', '3'],
              answer: 'A',
              explanation: 'a 传入 3，b 使用默认值 2，3 + 2 = 5。'
            }
          ]
        }
      ]
    },
    {
      id: 'ch4',
      title: '第四章 列表与字典',
      knowledgePoints: [
        {
          id: 'kp6',
          title: '列表与字典',
          summary: '列表 list 是有序集合用 []，字典 dict 是键值对用 {}，都支持增删改查。',
          keyPoints: [
            '列表：有序、可重复，支持索引访问，元素从 0 开始编号',
            '列表常用方法：append() 添加、remove() 删除、len() 求长度、切片 [1:3]',
            '字典：键值对存储，键唯一，通过 键 快速查找',
            '字典增改：d[\'key\'] = value；读取：d.get(\'key\', 默认值) 更安全'
          ],
          example: '```python\n# 列表\nfruits = ["苹果", "香蕉", "橘子"]\nfruits.append("西瓜")\nprint(fruits[0])      # 苹果\nprint(len(fruits))    # 4\n\n# 字典\nstu = {"name": "小明", "age": 18}\nstu["score"] = 95     # 新增\nprint(stu["name"])    # 小明\nprint(stu.get("sex", "未知"))  # 未知（键不存在，返回默认值）\n```',
          pitfalls: [
            '误区：stu[\'sex\'] 访问不存在的键会抛 KeyError，用 get() 可以避免',
            '误区：列表索引越界（如 fruits[10]）会抛 IndexError'
          ],
          quiz: [
            {
              q: '列表 fruits = ["苹果","香蕉"]，执行 fruits.append("橘子") 后长度是？',
              options: ['2', '3', '报错', '4'],
              answer: 'B',
              explanation: 'append 在末尾添加一个元素，长度从 2 变为 3。'
            },
            {
              q: 'd = {"a": 1}，访问 d.get("b") 的结果是？',
              options: ['报错', 'None', '0', 'false'],
              answer: 'B',
              explanation: 'get() 在键不存在时返回 None（或指定的默认值），不会报错。'
            }
          ]
        }
      ]
    },
    {
      id: 'ch5',
      title: '第五章 面向对象基础',
      knowledgePoints: [
        {
          id: 'kp7',
          title: '类与对象',
          summary: '类是对象的模板，用 class 定义；__init__ 是构造方法，self 代表实例自身。',
          keyPoints: [
            'class 类名: 定义类，类名通常用大驼峰命名（如 Student）',
            '__init__(self, ...) 构造方法，创建对象时自动调用',
            'self 代表当前实例，方法第一个参数必须是 self',
            '通过 对象.属性 / 对象.方法() 访问'
          ],
          example: '```python\nclass Student:\n    def __init__(self, name, score):\n        self.name = name\n        self.score = score\n\n    def intro(self):\n        return f"{self.name} 考了 {self.score} 分"\n\ns = Student("小明", 95)\nprint(s.intro())  # 小明 考了 95 分\n```',
          pitfalls: [
            '误区：类里方法忘记写 self 参数，调用时报参数数量错误',
            '注意：__init__ 前后各有两个下划线，不要写错'
          ],
          quiz: [
            {
              q: '构造方法（初始化方法）在 Python 中的名称是？',
              options: ['init()', '__init__()', 'constructor()', '__init()__'],
              answer: 'B',
              explanation: 'Python 用 __init__（前后各两个下划线）作为构造方法。'
            },
            {
              q: '实例方法的第一个参数通常是？',
              options: ['this', 'self', 'cls', 'obj'],
              answer: 'B',
              explanation: '实例方法第一个参数是 self，代表当前实例；类方法用 cls。'
            }
          ]
        }
      ]
    }
  ]
};

/** 工具函数：按 id 查知识点、查章节 */
function findKnowledgePoint(kpId) {
  for (const ch of course.chapters) {
    const kp = ch.knowledgePoints.find((k) => k.id === kpId);
    if (kp) return { kp, chapter: ch };
  }
  return null;
}

function getAllKnowledgePoints() {
  const list = [];
  for (const ch of course.chapters) {
    for (const kp of ch.knowledgePoints) list.push({ kp, chapter: ch });
  }
  return list;
}

module.exports = { course, findKnowledgePoint, getAllKnowledgePoints };
