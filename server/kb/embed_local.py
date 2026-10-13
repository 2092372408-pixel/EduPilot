# -*- coding: utf-8 -*-
"""
embed_local.py — 本地向量化长驻服务（fastembed + bge-small-zh-v1.5）
------------------------------------------------------------------------
协议（stdin/stdout 逐行 JSON）：
  -> {"id": 1, "texts": ["文本A", "文本B"]}
  <- {"id": 1, "vectors": [[0.01, ...], [...]]}

设计要点：
  1. 模型只加载一次，常驻进程服务后续请求（Node 侧 spawn 本脚本并保持连接）；
  2. 日志输出到 stderr，stdout 只输出协议 JSON（不污染管道）；
  3. 模型缓存于本机（首次运行自动从 HF 镜像下载 ~55MB），之后完全离线；
  4. 向量为 512 维 float32 列表（bge-small-zh-v1.5 中文优化）；
  5. 维度与云端 DashScope text-embedding-v3(1024) 不同 → 切换 provider 后需重建 vectors.json。

环境变量：
  HF_ENDPOINT      HuggingFace 镜像（默认 https://hf-mirror.com，国内加速）
  EMBED_MODEL      模型名（默认 BAAI/bge-small-zh-v1.5）
"""

import json
import os
import sys

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("OMP_NUM_THREADS", "4")

MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
# 固定缓存目录（默认系统 temp 会因会话 TMP 不同而漂移，导致模型反复重新下载）
DEFAULT_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "models", "fastembed_cache")
os.environ.setdefault("FASTEMBED_CACHE_PATH", DEFAULT_CACHE)
CACHE_DIR = os.environ.get("FASTEMBED_CACHE_PATH", DEFAULT_CACHE)


def log(msg):
    print(f"[embed_local] {msg}", file=sys.stderr, flush=True)


def load_model():
    from fastembed import TextEmbedding
    os.makedirs(CACHE_DIR, exist_ok=True)
    # 用 FASTEMBED_CACHE_PATH 指向本地缓存（命中即纯离线加载，不再联网下载）
    return TextEmbedding(model_name=MODEL, local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1")


def main():
    model = load_model()
    log(f"模型就绪: {MODEL} (512 维)")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            texts = req.get("texts") or []
            vectors = []
            if texts:
                # fastembed 支持批量；逐条收集为 list of list
                for vec in model.embed(texts):
                    vectors.append([float(x) for x in vec])
            sys.stdout.write(json.dumps({"id": req.get("id"), "vectors": vectors}) + "\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({"id": req.get("id"), "error": str(e)}) + "\n")
            sys.stdout.flush()
            log(f"请求处理失败: {e}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"启动失败: {e}")
        sys.exit(1)
