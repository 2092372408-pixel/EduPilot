const course = {
  id: 'python-intro',
  title: 'Python Intro',
  description: 'Zero-basis Python intro, covering variables, control flow, functions, data structures, and OOP.',
  chapters: [
    {
      id: 'ch1',
      title: 'Ch1: Variables & Data Types',
      knowledgePoints: [
        {
          id: 'kp1',
          title: 'Variables & Assignment',
          summary: 'Variables are used to store data, created using the = assignment operator, without needing to declare their type.',
          keyPoints: [
            'Variable names must consist of letters, numbers, and underscores, and cannot start with a number.',
            'Assignment uses =, for example: age = 18.',
            'Python is dynamically typed; variable types can change at any time.',
            'Case sensitive: Name and name are different variables.'
          ],
          example: '```python\nname = "Alice"\nage = 18\nprint(name, age)\n\nage = "eighteen"  # Type changed to string\nprint(age)\n```',
          pitfalls: [
            'Misconception: x = y means x and y are bound forever; actually it just passes the reference.',
            'Naming error: using keywords (like if, class) as variable names.'
          ],
          quiz: [
            {
              q: 'Which of the following is a valid Python variable name?',
              options: ['2name', 'my-name', 'my_name', 'my name'],
              answer: 'C',
              explanation: 'Variable names cannot start with a number (A) or contain hyphens (B) or spaces (D). Underscores are allowed (C).'
            },
            {
              q: 'After a = 5; b = a; a = 10, what is the value of b?',
              options: ['5', '10', 'error', '15'],
              answer: 'A',
              explanation: 'b = a assigns the current value 5 to b. Reassigning a to 10 does not change b.'
            },
            {
              q: 'Do Python variables require an explicit type declaration?',
              options: ['Yes, for example int x = 5', 'No, types are inferred automatically', 'Yes, but it is optional', 'Only strings require one'],
              answer: 'B',
              explanation: 'Python is dynamically typed. In x = 5, the value is automatically recognized as an integer.'
            }
          ]
        },
        {
          id: 'kp2',
          title: 'Common Data Types',
          summary: 'Python has several basic data types: integers (int), floats (float), strings (str), and booleans (bool).',
          keyPoints: [
            'Integer (int): 1, -5, 100',
            'Float (float): 3.14, -0.5',
            'String (str): "Hello" or \'World\'',
            'Boolean (bool): True or False (note the capitalization)',
            'Use type(var) to check the type of a variable.'
          ],
          example: '```python\na = 10          # int\nb = 3.14        # float\nc = "Python"    # str\nd = True        # bool\n\nprint(type(a))  # <class \'int\'>\n```',
          pitfalls: [
            'Misconception: "10" and 10 are the same; one is a string, the other is an integer, they cannot be directly added.',
            'Boolean True and False must start with an uppercase letter.'
          ],
          quiz: [
            {
              q: 'What is the output of type(3.14)?',
              options: ['<class \'int\'>', '<class \'float\'>', '<class \'str\'>', '<class \'bool\'>'],
              answer: 'B',
              explanation: '3.14 is a floating point number, Python represents this as float.'
            },
            {
              q: 'What happens when Python evaluates "3" + 5?',
              options: ['The number 8', 'The string "35"', 'A TypeError', 'The number 35'],
              answer: 'C',
              explanation: 'A string and an integer cannot be added directly. Python raises a TypeError.'
            }
          ]
        }
      ]
    },
    {
      id: 'ch2',
      title: 'Ch2: Control Flow',
      knowledgePoints: [
        {
          id: 'kp3',
          title: 'Conditions: if / elif / else',
          summary: 'Use if statements to execute different code blocks based on conditions. Python relies on indentation.',
          keyPoints: [
            'if condition: starts the block, subsequent lines must be indented.',
            'elif handles multiple conditions; else handles the default case.',
            'Conditional operators: == (equal), != (not equal), > (greater than), < (less than).',
            'Logical operators: and, or, not.'
          ],
          example: '```python\nscore = 85\nif score >= 90:\n    print("Excellent")\nelif score >= 60:\n    print("Pass")\nelse:\n    print("Fail")\n```',
          pitfalls: [
            'Misconception: Using = instead of == for comparison, causing a syntax error.',
            'Forgetting the colon (:) at the end of the if statement.',
            'Inconsistent indentation leading to an IndentationError.'
          ],
          quiz: [
            {
              q: 'Which operator is used to check for equality?',
              options: ['=', '==', '===', ':='],
              answer: 'B',
              explanation: 'Python uses == to check equality. = is for assignment, and === does not exist.'
            },
            {
              q: 'What is required for the body of an if statement?',
              options: ['Enclosed in curly braces {}', 'Ends with a semicolon', 'Indented on the next line, with a colon after the condition', 'Must be followed by else'],
              answer: 'C',
              explanation: 'Python uses a colon (:) and indentation to define code blocks, not curly braces.'
            }
          ]
        },
        {
          id: 'kp4',
          title: 'Loops: for / while',
          summary: 'for is used to iterate over sequences, while loops based on a condition. break exits the loop, continue skips an iteration.',
          keyPoints: [
            'for var in seq: iterates through a list, string, or range().',
            'range(5) generates 0 to 4; range(1, 5) generates 1 to 4.',
            'while condition: executes as long as the condition is True. Prevent infinite loops!',
            'break ends the entire loop immediately; continue skips the rest of the current iteration.'
          ],
          example: '```python\n# for loop\nfor i in range(3):\n    print(i)  # Outputs 0 1 2\n\n# while loop\nn = 3\nwhile n > 0:\n    print(n)\n    n -= 1  # Outputs 3 2 1\n```',
          pitfalls: [
            'Misconception: Forgetting to update the loop variable in a while loop causes an infinite loop.',
            'Misconception: range(5) includes 5. To include 5, use range(6).'
          ],
          quiz: [
            {
              q: 'What numbers are generated by range(5)?',
              options: ['1,2,3,4,5', '0,1,2,3,4', '0,1,2,3,4,5', '1,2,3,4'],
              answer: 'B',
              explanation: 'range(n) generates numbers from 0 up to n-1. Therefore, range(5) is 0, 1, 2, 3, 4.'
            },
            {
              q: 'What is the purpose of the break statement?',
              options: ['Skip the current iteration', 'End the entire loop', 'Exit the program', 'Jump to the next line'],
              answer: 'B',
              explanation: 'break terminates the loop completely. continue is used to skip the current iteration.'
            }
          ]
        }
      ]
    },
    {
      id: 'ch3',
      title: 'Ch3: Functions',
      knowledgePoints: [
        {
          id: 'kp5',
          title: 'Function Def & Call',
          summary: 'Functions are defined using def, encapsulating reusable code blocks, supporting parameters and return values.',
          keyPoints: [
            'def function_name(args): defines a function. The body must be indented.',
            'return specifies the result. If no return is present, the function returns None.',
            'Default parameters are supported: def greet(name="Student").',
            'Functions must be defined before they are called.'
          ],
          example: '```python\ndef greet(name):\n    return "Hello, " + name\n\nmsg = greet("Alice")\nprint(msg)  # Hello, Alice\n\ndef add(a, b=1):\n    return a + b\n\nprint(add(5))    # 6 (b uses default)\nprint(add(5, 3)) # 8\n```',
          pitfalls: [
            'Misconception: Assuming a function without a return statement returns 0; it actually returns None.',
            'Note: Arguments are passed by position. Parameters with default values must be placed at the end.'
          ],
          quiz: [
            {
              q: 'What does a function return if it lacks a return statement?',
              options: ['0', 'Empty string', 'None', 'Throws an error'],
              answer: 'C',
              explanation: 'Functions without a return statement return None by default.'
            },
            {
              q: 'Given def f(a, b=2): return a + b, what is the result of f(3)?',
              options: ['5', 'error', '2', '3'],
              answer: 'A',
              explanation: 'a receives 3, b uses its default value 2. 3 + 2 = 5.'
            }
          ]
        }
      ]
    },
    {
      id: 'ch4',
      title: 'Ch4: Lists & Dicts',
      knowledgePoints: [
        {
          id: 'kp6',
          title: 'Lists & Dictionaries',
          summary: 'Lists (list) are ordered collections using []. Dictionaries (dict) are key-value pairs using {}. Both are mutable.',
          keyPoints: [
            'Lists: Ordered, allows duplicates, accessed by index (starts at 0).',
            'List methods: append() to add, remove() to delete, len() for size, slicing like [1:3].',
            'Dictionaries: Stores key-value pairs, keys are unique, fast lookups.',
            'Dict update: d["key"] = value. Reading: d.get("key", default) is safer.'
          ],
          example: '```python\n# List\nfruits = ["apple", "banana", "orange"]\nfruits.append("watermelon")\nprint(fruits[0])      # apple\nprint(len(fruits))    # 4\n\n# Dictionary\nstu = {"name": "Alice", "age": 18}\nstu["score"] = 95     # Add\nprint(stu["name"])    # Alice\nprint(stu.get("gender", "unknown"))  # unknown (key not found)\n```',
          pitfalls: [
            'Misconception: Accessing a missing key via stu["gender"] throws a KeyError. Use get() to avoid this.',
            'Misconception: Accessing an out-of-bounds list index (e.g. fruits[10]) throws an IndexError.'
          ],
          quiz: [
            {
              q: 'Given fruits = ["apple", "banana"], what is its length after fruits.append("orange")?',
              options: ['2', '3', 'error', '4'],
              answer: 'B',
              explanation: 'append adds an element to the end, increasing the length from 2 to 3.'
            },
            {
              q: 'Given d = {"a": 1}, what is the result of d.get("b")?',
              options: ['error', 'None', '0', 'false'],
              answer: 'B',
              explanation: 'get() returns None (or a specified default) if the key does not exist. It does not throw an error.'
            }
          ]
        }
      ]
    },
    {
      id: 'ch5',
      title: 'Ch5: OOP Basics',
      knowledgePoints: [
        {
          id: 'kp7',
          title: 'Classes & Objects',
          summary: 'Classes are templates for objects, defined with class. __init__ is the constructor, and self represents the instance.',
          keyPoints: [
            'class ClassName: defines a class. Names use CamelCase (e.g., Student).',
            '__init__(self, ...) is the constructor, called automatically when an object is created.',
            'self represents the current instance. It must be the first parameter of instance methods.',
            'Access properties and methods using object.property or object.method().'
          ],
          example: '```python\nclass Student:\n    def __init__(self, name, score):\n        self.name = name\n        self.score = score\n\n    def intro(self):\n        return f"{self.name} scored {self.score}"\n\ns = Student("Alice", 95)\nprint(s.intro())  # Alice scored 95\n```',
          pitfalls: [
            'Misconception: Forgetting the self parameter in methods causes argument count errors during calls.',
            'Note: __init__ has two underscores before and after. Do not misspell it.'
          ],
          quiz: [
            {
              q: 'What is the name of the constructor (initialization method) in Python?',
              options: ['init()', '__init__()', 'constructor()', '__init()__'],
              answer: 'B',
              explanation: 'Python uses __init__ (double underscores on both sides) as the constructor method.'
            },
            {
              q: 'What is typically the first parameter of an instance method?',
              options: ['this', 'self', 'cls', 'obj'],
              answer: 'B',
              explanation: 'The first parameter of an instance method is self, representing the current instance. Class methods use cls.'
            }
          ]
        }
      ]
    }
  ]
};

/** Utility functions: find by id */
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
