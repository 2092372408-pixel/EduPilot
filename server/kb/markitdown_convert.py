# -*- coding: utf-8 -*-
"""markitdown_convert.py — Node(spawn) → MarkItDown 桥接（上传方案 v2 · U1）

用法: python markitdown_convert.py <srcPath>
stdout: 转换后的 Markdown 文本（UTF-8），解析失败 exit code != 0 + stderr 原因。

环境: 项目 .venv-upload/（pip install markitdown[pdf,docx,pptx]）。
"""
import sys

def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python markitdown_convert.py <srcPath>", file=sys.stderr)
        return 2
    src = sys.argv[1]
    try:
        from markitdown import MarkItDown
    except ImportError as e:
        print(f"markitdown 未安装: {e}（请先执行 .venv-upload/Scripts/pip install 'markitdown[pdf,docx,pptx]'）",
              file=sys.stderr)
        return 3
    try:
        md = MarkItDown()
        result = md.convert(src)
        out = result.text_content or ""
        sys.stdout.write(out)
        return 0
    except Exception as e:  # noqa: BLE001  —— 原因透传给 Node 上层提示
        print(f"MarkItDown convert 失败: {e}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        sys.exit(0)
