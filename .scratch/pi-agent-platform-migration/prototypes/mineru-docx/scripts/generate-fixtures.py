from __future__ import annotations

import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures"
PAGE_WIDTH, PAGE_HEIGHT = A4


def find_cjk_font() -> Path:
    candidates = [
        os.environ.get("SPIKE05_CJK_FONT"),
        Path.home() / "Library/Fonts/MapleMono-NF-CN-Medium.ttf",
        Path("/System/Library/Fonts/STHeiti Medium.ttc"),
        Path("/System/Library/Fonts/Supplemental/Songti.ttc"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise RuntimeError("Set SPIKE05_CJK_FONT to a Chinese-capable TTF/TTC font")


FONT_PATH = find_cjk_font()
pdfmetrics.registerFont(TTFont("FixtureCJK", str(FONT_PATH), subfontIndex=0))


def pdf(path: Path) -> canvas.Canvas:
    return canvas.Canvas(str(path), pagesize=A4, pageCompression=1)


def lines(
    c: canvas.Canvas, items: list[str], x: float, y: float, leading: float = 17
) -> float:
    c.setFont("FixtureCJK", 10.5)
    for item in items:
        c.drawString(x, y, item)
        y -= leading
    return y


def born_digital() -> dict:
    path = FIXTURES / "01-born-digital-bilingual.pdf"
    c = pdf(path)
    c.setTitle("Spike 05 bilingual born-digital fixture")
    c.setFont("FixtureCJK", 19)
    c.drawString(48, PAGE_HEIGHT - 55, "可编辑研究简报 / Editable Research Brief")
    c.setFont("FixtureCJK", 9)
    c.drawString(48, PAGE_HEIGHT - 78, "OGEN-S05-PROSE-001")
    y = PAGE_HEIGHT - 115
    y = lines(
        c,
        [
            "摘要：这是一份新生成的非敏感测试文档，用来检查中文、English 与数字 2026 的阅读顺序。",
            "The first paragraph must remain before the second paragraph after conversion.",
            "关键词：本地优先、可编辑、语义保真；Keywords: local-first, editable, semantic fidelity.",
            "第二节：混排标点（A/B）、邮箱 test@example.invalid 与编号 R-2048 都应保留。",
        ],
        48,
        y,
        24,
    )
    c.setFillColor(colors.HexColor("#EAF0FF"))
    c.roundRect(48, y - 120, PAGE_WIDTH - 96, 90, 10, fill=1, stroke=0)
    c.setFillColor(colors.HexColor("#1D2A44"))
    lines(
        c,
        [
            "结论 / Conclusion",
            "正文应保持可搜索、可编辑；标题层级和段落顺序比逐像素版式更重要。",
            "Text should remain searchable and editable; hierarchy outranks pixel identity.",
        ],
        64,
        y - 56,
        20,
    )
    c.showPage()
    c.save()
    return {
        "file": path.name,
        "class": "born-digital-bilingual",
        "markers": ["OGEN-S05-PROSE-001", "R-2048", "本地优先"],
        "expected": {"textLayer": True, "tables": 0, "imagesAtLeast": 0},
    }


def two_column_formula() -> dict:
    path = FIXTURES / "02-two-column-formula.pdf"
    c = pdf(path)
    c.setTitle("Spike 05 two-column formula fixture")
    c.setFont("FixtureCJK", 18)
    c.drawString(42, PAGE_HEIGHT - 52, "双栏与公式 / Two-column and Formula")
    c.setStrokeColor(colors.HexColor("#B8C2D8"))
    c.line(PAGE_WIDTH / 2, 70, PAGE_WIDTH / 2, PAGE_HEIGHT - 80)
    left = [
        "LEFT-COLUMN-01",
        "左栏第一段必须先于右栏出现。",
        "Left item A: alpha = 0.125",
        "Left item B: sample size n = 64",
        "行内公式：E = mc²",
    ]
    right = [
        "RIGHT-COLUMN-01",
        "右栏从这个标记开始。",
        "Right item A: beta = 2.5",
        "Right item B: confidence = 95%",
        "块级公式：f(x) = x² + 2x + 1",
    ]
    lines(c, left, 42, PAGE_HEIGHT - 105, 25)
    lines(c, right, PAGE_WIDTH / 2 + 18, PAGE_HEIGHT - 105, 25)
    c.setFillColor(colors.HexColor("#F5F7FA"))
    c.roundRect(70, 175, PAGE_WIDTH - 140, 110, 8, fill=1, stroke=0)
    c.setFillColor(colors.black)
    c.setFont("FixtureCJK", 16)
    c.drawCentredString(PAGE_WIDTH / 2, 240, "FORMULA-BLOCK-01")
    c.drawCentredString(PAGE_WIDTH / 2, 208, "Σᵢ xᵢ / n = μ ;  ∫₀¹ x² dx = 1/3")
    c.showPage()
    c.save()
    return {
        "file": path.name,
        "class": "two-column-formula",
        "markers": ["LEFT-COLUMN-01", "RIGHT-COLUMN-01", "FORMULA-BLOCK-01"],
        "expected": {"textLayer": True, "tables": 0, "imagesAtLeast": 0},
    }


def table_and_image() -> dict:
    path = FIXTURES / "03-merged-table-image.pdf"
    image_path = FIXTURES / "source-chart.png"
    image = Image.new("RGB", (700, 320), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 699, 319), outline="#243B64", width=5)
    for index, height in enumerate([90, 180, 130, 240]):
        x = 90 + index * 140
        draw.rectangle((x, 280 - height, x + 75, 280), fill="#4E7BEF")
    draw.text(
        (25, 20),
        "IMAGE-ASSET-01",
        fill="#111111",
        font=ImageFont.truetype(str(FONT_PATH), 30),
    )
    image.save(image_path)

    c = pdf(path)
    c.setTitle("Spike 05 merged table and image fixture")
    c.setFont("FixtureCJK", 18)
    c.drawString(42, PAGE_HEIGHT - 52, "合并单元格表格与图片 / Editable Table + Image")
    x0, y0, width, row_height = 42, PAGE_HEIGHT - 115, PAGE_WIDTH - 84, 36
    columns = 4
    column_width = width / columns
    rows = 5
    c.setStrokeColor(colors.HexColor("#344563"))
    c.rect(x0, y0 - rows * row_height, width, rows * row_height)
    for row in range(1, rows):
        c.line(x0, y0 - row * row_height, x0 + width, y0 - row * row_height)
    for column in range(1, columns):
        c.line(
            x0 + column * column_width,
            y0 - row_height,
            x0 + column * column_width,
            y0 - rows * row_height,
        )
    c.setFillColor(colors.HexColor("#E8EEFF"))
    c.rect(x0, y0 - row_height, width, row_height, fill=1, stroke=0)
    c.setFillColor(colors.black)
    c.setFont("FixtureCJK", 11)
    c.drawCentredString(x0 + width / 2, y0 - 24, "MERGED-HEADER-01 / 2026 实验结果")
    values = [
        ["样本", "A-01", "B-01", "C-01"],
        ["数值", "12.5", "18.0", "21.5"],
        ["状态", "通过", "复核", "通过"],
        ["备注", "alpha", "beta", "gamma"],
    ]
    for row, values_row in enumerate(values, start=1):
        for column, value in enumerate(values_row):
            c.drawCentredString(
                x0 + (column + 0.5) * column_width,
                y0 - (row + 0.68) * row_height,
                value,
            )
    c.drawImage(
        ImageReader(str(image_path)), 72, 105, width=PAGE_WIDTH - 144, height=195
    )
    c.setFont("FixtureCJK", 9)
    c.drawCentredString(PAGE_WIDTH / 2, 88, "图 1 / Figure 1 — IMAGE-ASSET-01")
    c.showPage()
    c.save()
    return {
        "file": path.name,
        "class": "merged-table-image",
        "markers": ["MERGED-HEADER-01", "A-01", "IMAGE-ASSET-01"],
        "expected": {"textLayer": True, "tables": 1, "imagesAtLeast": 1},
    }


def image_heavy() -> dict:
    path = FIXTURES / "04-image-heavy.pdf"
    c = pdf(path)
    c.setTitle("Spike 05 image-heavy fixture")
    c.setFont("FixtureCJK", 17)
    c.drawString(42, PAGE_HEIGHT - 52, "图片密集页 / Image-heavy Page — IMAGE-GRID-01")
    palette = ["#3454D1", "#34A853", "#F9AB00", "#D93025", "#7B61FF", "#00A3A3"]
    for index, color in enumerate(palette):
        column, row = index % 2, index // 2
        x = 46 + column * 270
        y = PAGE_HEIGHT - 255 - row * 220
        c.setFillColor(colors.HexColor(color))
        c.roundRect(x, y, 230, 150, 12, fill=1, stroke=0)
        c.setFillColor(colors.white)
        c.setFont("FixtureCJK", 14)
        c.drawCentredString(x + 115, y + 78, f"ASSET-{index + 1:02d}")
        c.setFillColor(colors.black)
        c.setFont("FixtureCJK", 9)
        c.drawCentredString(
            x + 115, y - 16, f"图 {index + 1} / Generated diagram {index + 1}"
        )
    c.showPage()
    c.save()
    return {
        "file": path.name,
        "class": "image-heavy",
        "markers": ["IMAGE-GRID-01", "ASSET-01", "ASSET-06"],
        "expected": {"textLayer": True, "tables": 0, "imagesAtLeast": 0},
        "note": "Vector drawings may remain drawing objects or be rasterized; all six panels must remain visible.",
    }


def scanned_bilingual() -> dict:
    path = FIXTURES / "05-scanned-bilingual.pdf"
    width, height = 1240, 1754
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    title_font = ImageFont.truetype(str(FONT_PATH), 52)
    body_font = ImageFont.truetype(str(FONT_PATH), 32)
    draw.rectangle((45, 45, width - 45, height - 45), outline="#26364A", width=4)
    draw.text((85, 105), "扫描页 / Scanned Page", fill="#111111", font=title_font)
    scanned_lines = [
        "SCAN-BILINGUAL-01",
        "这段中文只存在于页面图像中，没有 PDF 文本层。",
        "This English sentence exists only inside the raster image.",
        "识别编号：OCR-7391；日期：2026-08-09。",
        "阅读顺序应从上到下，且不能遗漏中文标点。",
    ]
    y = 250
    for item in scanned_lines:
        draw.text((85, y), item, fill="#202020", font=body_font)
        y += 105
    draw.line((85, y + 20, width - 85, y + 20), fill="#777777", width=3)
    draw.text((85, y + 75), "END-SCAN-01", fill="#111111", font=body_font)

    c = pdf(path)
    c.setTitle("Spike 05 scanned bilingual fixture")
    c.drawImage(ImageReader(image), 0, 0, width=PAGE_WIDTH, height=PAGE_HEIGHT)
    c.showPage()
    c.save()
    return {
        "file": path.name,
        "class": "scanned-bilingual",
        "markers": ["SCAN-BILINGUAL-01", "OCR-7391", "END-SCAN-01"],
        "expected": {"textLayer": False, "tables": 0, "imagesAtLeast": 1},
    }


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    corpus = [
        born_digital(),
        two_column_formula(),
        table_and_image(),
        image_heavy(),
        scanned_bilingual(),
    ]
    for item in corpus:
        reader = PdfReader(FIXTURES / item["file"])
        if len(reader.pages) != 1:
            raise RuntimeError(f"{item['file']} must contain one page")
        extracted = (reader.pages[0].extract_text() or "").strip()
        has_text = bool(extracted)
        if has_text != item["expected"]["textLayer"]:
            raise RuntimeError(f"{item['file']} text-layer expectation failed")
        item["bytes"] = (FIXTURES / item["file"]).stat().st_size
        item["pages"] = 1
    manifest = {
        "schemaVersion": 1,
        "purpose": "Synthetic non-sensitive MinerU PDF-to-DOCX fidelity corpus",
        "fontSource": FONT_PATH.name,
        "documents": corpus,
    }
    (FIXTURES / "corpus.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {"fixtures": len(corpus), "pages": len(corpus), "path": str(FIXTURES)}
        )
    )


if __name__ == "__main__":
    main()
