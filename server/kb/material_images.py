"""Local material images. PDF pages are rendered only when requested by the model."""
import hashlib
import io
import json
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET
import zipfile
from PIL import Image

MAX_IMAGES = 500
MAX_BYTES = 64 * 1024 * 1024


def compact(text):
    return re.sub(r'\s+', '', text)


def raster(data):
    image = Image.open(io.BytesIO(data))
    if image.width * image.height > 40_000_000:
        raise ValueError('图片像素超过 4000 万')
    image.thumbnail((1600, 1600))
    output = io.BytesIO()
    image.convert('RGB').save(output, format='JPEG', quality=85)
    return output.getvalue()


def extract(source, directory):
    os.makedirs(directory, exist_ok=True)
    rows, warnings = [], []
    ext = os.path.splitext(source)[1].lower()
    source_id = hashlib.sha256(open(source, 'rb').read()).hexdigest()[:24]
    total = 0

    def save(data, anchor, label, page=None):
        nonlocal total
        if len(rows) >= MAX_IMAGES:
            raise ValueError('图片引用超过 500 个，后续图片未保留')
        total += len(data)
        if total > MAX_BYTES:
            raise ValueError('图片总量超过 64MB，后续图片未保留')
        image_id = hashlib.sha256((source_id + str(len(rows))).encode()).hexdigest()[:24]
        filename = image_id + '.jpg'
        original = image_id + '.original'
        # Preserve the exact embedded bytes; the JPEG is only a bounded model-input preview.
        with open(os.path.join(directory, original), 'wb') as out:
            out.write(data)
        row = dict(imageId=image_id, filename=filename, original=original, anchor=anchor, label=label, page=page)
        try:
            preview = raster(data)
            with open(os.path.join(directory, filename), 'wb') as out:
                out.write(preview)
        except (OSError, ValueError) as error:
            row['previewError'] = '原始图片已保留，但无法生成模型预览：' + str(error)
            warnings.append(row['previewError'])
        rows.append(row)

    try:
        if ext == '.pdf':
            import pdfplumber
            filename = 'source-' + source_id + '.pdf'
            shutil.copyfile(source, os.path.join(directory, filename))
            with pdfplumber.open(source) as pdf:
                for index, page in enumerate(pdf.pages):
                    if index >= MAX_IMAGES:
                        warnings.append('PDF 超过 500 页，仅前 500 页保留按需图片读取引用')
                        break
                    # Keep page references, including vector diagrams; no rasterization during import.
                    lines = [line.strip() for line in (page.extract_text() or '').splitlines() if len(compact(line)) >= 8]
                    anchor = lines[:8]
                    image_id = hashlib.sha256((source_id + ':' + str(index)).encode()).hexdigest()[:24]
                    rows.append(dict(imageId=image_id, filename=image_id + '.jpg', source=filename,
                                     page=index + 1, anchor=anchor, label='PDF 原文第 %d 页' % (index + 1)))
        elif ext in ('.docx', '.pptx'):
            with zipfile.ZipFile(source) as archive:
                if ext == '.docx':
                    parts = ['word/document.xml']
                else:
                    parts = sorted((n for n in archive.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)),
                                   key=lambda n: int(re.search(r'(\d+)\.xml$', n).group(1)))
                for index, part in enumerate(parts):
                    base = os.path.dirname(part)
                    relpath = base + '/_rels/' + os.path.basename(part) + '.rels'
                    rels = {}
                    if relpath in archive.namelist():
                        for rel in ET.fromstring(archive.read(relpath)):
                            if rel.get('TargetMode') != 'External':
                                rels[rel.get('Id')] = os.path.normpath(base + '/' + rel.get('Target', '')).replace('\\', '/')
                    tree = ET.fromstring(archive.read(part))
                    paragraphs = [node for node in tree.iter() if node.tag.rsplit('}', 1)[-1] == 'p']
                    previous = []
                    slide_anchor = [''.join(n.itertext()) for n in tree.iter() if n.tag.rsplit('}', 1)[-1] == 't'][:8]
                    for paragraph in paragraphs:
                        text = ''.join(n.text or '' for n in paragraph.iter() if n.tag.rsplit('}', 1)[-1] == 't')
                        if len(compact(text)) >= 8:
                            previous = [text]
                        for node in paragraph.iter():
                            if node.tag.rsplit('}', 1)[-1] not in ('blip', 'imagedata'):
                                continue
                            rel_id = next((v for k, v in node.attrib.items() if k.rsplit('}', 1)[-1] in ('embed', 'id')), None)
                            target = rels.get(rel_id)
                            if target and target in archive.namelist():
                                info = archive.getinfo(target)
                                if info.file_size > 16 * 1024 * 1024:
                                    warnings.append('已跳过超过 16MB 的嵌入图片')
                                    continue
                                try:
                                    save(archive.read(target), previous or slide_anchor,
                                         ('幻灯片 %d 图片' % (index + 1)) if ext == '.pptx' else 'Word 嵌入图片',
                                         index + 1 if ext == '.pptx' else None)
                                except (OSError, ValueError) as error:
                                    warnings.append('图片未保留：' + str(error))
                    # PowerPoint pictures are siblings of text shapes, outside paragraphs.
                    if ext == '.pptx':
                        for node in tree.iter():
                            if node.tag.rsplit('}', 1)[-1] != 'pic':
                                continue
                            for blip in node.iter():
                                if blip.tag.rsplit('}', 1)[-1] == 'blip':
                                    rel_id = next((v for k, v in blip.attrib.items() if k.rsplit('}', 1)[-1] == 'embed'), None)
                                    target = rels.get(rel_id)
                                    if target and target in archive.namelist() and archive.getinfo(target).file_size <= 16 * 1024 * 1024:
                                        try:
                                            save(archive.read(target), slide_anchor, '幻灯片 %d 图片' % (index + 1), index + 1)
                                        except (OSError, ValueError) as error:
                                            warnings.append('图片未保留：' + str(error))
    except Exception as error:
        warnings.append('图片保留未完成：' + str(error))
    print(json.dumps(dict(images=rows, warnings=warnings), ensure_ascii=False))


def render(source, page, output):
    import pdfplumber
    with pdfplumber.open(source) as pdf:
        target = pdf.pages[int(page) - 1]
        resolution = min(110, 1600 * 72 / max(target.width, target.height))
        image = target.to_image(resolution=resolution).original
        image.thumbnail((1600, 1600))
        image.convert('RGB').save(output, format='JPEG', quality=85)


if sys.argv[1] == 'extract':
    extract(sys.argv[2], sys.argv[3])
elif sys.argv[1] == 'render':
    render(sys.argv[2], sys.argv[3], sys.argv[4])
