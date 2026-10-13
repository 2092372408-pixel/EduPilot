#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sandbox_precheck.py — Python 代码沙箱的 AST 层预检（白名单）
------------------------------------------------------------
为什么需要它：runner.js 的**正则黑名单**可以被绕过（如通过 __subclasses__ /
__globals__ / getattr 的 dunder 遍历拿到危险对象）。黑名单永远列不全，因此这里做
**白名单 + AST 结构校验**，作为运行前的第二道闸（与正则黑名单叠加，不替代）：

  1. import 白名单：只允许教学需要的安全标准库模块（math/random/string/datetime…）；
     其余（os/sys/subprocess/socket/shutil/ctypes/pickle/…）一律拒绝。
  2. 禁用语法：exec/eval/compile/__import__、dunder 属性访问（__class__/__globals__/
     __subclasses__/__builtins__ …）、open()、attribute 链上的危险调用。
  3. 只做静态检查，不执行任何代码。

输入：从 stdin 读取待检代码；输出：JSON {ok:bool, reason:str|null, violations:[...]} 到 stdout。
注意：本脚本本身由 runner.js 以 `python -I -X utf8 sandbox_precheck.py` 调用，属可信代码。
"""

import ast
import json
import re
import sys

# 允许的教学常用标准库（白名单）
# 注意：不含 pdb / traceback 等"可执行代码或读取栈帧"的调试模块 —— pdb.Pdb().run("...")
# 能执行任意代码，是 AST 白名单里最危险的漏网入口（已实测逃逸）。
ALLOWED_MODULES = {
    "math", "random", "string", "datetime", "time", "decimal", "fractions",
    "statistics", "itertools", "functools", "collections", "heapq", "bisect",
    "copy", "re", "json", "typing", "dataclasses", "enum", "abc", "numbers",
    "operator", "textwrap", "unicodedata", "uuid", "hashlib", "base64",
    "csv",
}

# 明确危险的内建函数名
BANNED_NAMES = {
    "eval", "exec", "compile", "__import__", "open", "input", "globals",
    "locals", "vars", "dir", "getattr", "setattr", "delattr", "breakpoint",
    "memoryview",
}

# 危险的属性/dunder（无论怎么拿到都拒绝）
BANNED_ATTRS = {
    "__class__", "__bases__", "__subclasses__", "__mro__", "__globals__",
    "__builtins__", "__code__", "__closure__", "__func__", "__self__",
    "__dict__", "__getattribute__", "__setattr__", "__reduce__", "__reduce_ex__",
    "func_globals", "gi_frame", "f_globals", "f_locals", "cr_frame",
    # 通过字符串参数间接取属性/调用的入口（attrgetter('__class__') 可绕过 ast.Attribute 检查）
    "attrgetter", "methodcaller",
    "open", "_getframe", "currentframe",
}

# 字符串字面量中的危险 dunder（防止把 __class__ 等写成字符串绕过属性检查）
BANNED_STR_RE = re.compile(
    r"__class__|__bases__|__subclasses__|__mro__|__globals__|__builtins__"
    r"|__code__|__closure__|__func__|__self__|__dict__|__reduce__|__import__"
)


def check(code: str):
    violations = []
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return {"ok": False, "reason": f"语法错误：{e.msg}（第 {e.lineno} 行）", "violations": ["syntax"]}

    for node in ast.walk(tree):
        # import X / from X import Y
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in ALLOWED_MODULES:
                    violations.append(f"import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if node.level and node.level > 0:
                violations.append("相对导入")
            elif root and root not in ALLOWED_MODULES:
                violations.append(f"from {node.module} import ...")
        # 禁用内建调用
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in BANNED_NAMES:
                violations.append(f"调用 {node.func.id}()")
        # 禁用属性访问（dunder / 危险属性）
        elif isinstance(node, ast.Attribute):
            if node.attr in BANNED_ATTRS:
                violations.append(f"访问 .{node.attr}")
        # 禁用名称（如直接引用 __builtins__）
        elif isinstance(node, ast.Name):
            if node.id in BANNED_NAMES or node.id in ("__builtins__", "__loader__", "__spec__"):
                violations.append(f"引用 {node.id}")
        # 字符串字面量里的危险 dunder / 模块名：attrgetter('__class__')、p.run("...") 等
        # 靠"把危险名字写成字符串"来绕过属性检查的路径，在此一并拦下
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if BANNED_STR_RE.search(node.value):
                violations.append("字符串中包含危险 dunder 名称")

    uniq = sorted(set(violations))
    if uniq:
        return {"ok": False, "reason": "代码包含不允许的操作：" + "、".join(uniq[:4]), "violations": uniq}
    return {"ok": True, "reason": None, "violations": []}


def main():
    code = sys.stdin.read()
    try:
        result = check(code)
    except Exception as e:  # 预检自身异常：保守起见标记不通过，交由正则黑名单与隔离兜底
        result = {"ok": False, "reason": f"预检异常：{e}", "violations": ["precheck_error"]}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
